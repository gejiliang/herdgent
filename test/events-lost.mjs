#!/usr/bin/env node
// events_lost 自愈（herdr ≥ 0.9.2 的上游 #4225 契约；0.9.1 不会真发，这里用假 socket 模拟）：
//   Part 1（lib 层）—— watchPaneStatus 把订阅中途的 events_lost 错误行报给
//     onProtocolError，不静默、不当事件；服务器关流后 onClose 照常。
//   Part 2（wait 层）—— wait_for_worker 收到 events_lost 后自动重订阅 + 补查，
//     worker 照常 settled，不落 unreachable；连续丢失超上限才落 unreachable。
//
// 隔离是结构性的：fake herdr CLI + 本文件自带的假事件 socket，
// 这个进程与 mcp-server 子进程都【根本连不上】真 herdr（AGENTS.md 铁律）。
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFakeHerdr, writePiTranscript, mcpProbe } from "./fake-herdr.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一个会话一个行为的假事件 socket。script(connIndex) 返回要执行的动作序列。
function startScriptedSocket(socketPath, script) {
  const state = { subs: 0 };
  const server = createNetServer((client) => {
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method !== "events.subscribe") continue;
        state.subs += 1;
        client.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
        script(state.subs, client, msg);
      }
    });
  });
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(socketPath, () => {
      server.off("error", rej);
      res({ server, state });
    });
  });
}

const home = mkdtempSync(join(tmpdir(), "hg-events-lost-"));

try {
  // ================= Part 1：lib/events.mjs 的协议识别 =================
  {
    const sock = join(home, "p1.sock");
    const { server } = await startScriptedSocket(sock, (n, client, msg) => {
      if (n === 1) {
        setTimeout(() => {
          client.write(
            JSON.stringify({ event: "pane.agent_status_changed", data: { agent: "pi", agent_status: "working", pane_id: "w1:p1", workspace_id: "w1" } }) + "\n",
          );
        }, 50);
        // herdr ≥ 0.9.2：带原请求 id 的 events_lost 错误行，随后关闭这条订阅
        setTimeout(() => {
          client.write(JSON.stringify({ id: msg.id, error: { code: "events_lost", message: "event subscription fell behind retained history" } }) + "\n");
        }, 100);
        setTimeout(() => client.destroy(), 150);
      } else {
        setTimeout(() => {
          client.write(
            JSON.stringify({ event: "pane.agent_status_changed", data: { agent: "pi", agent_status: "idle", pane_id: "w1:p1", workspace_id: "w1" } }) + "\n",
          );
        }, 50);
      }
    });

    process.env.HERDR_SOCKET_PATH = sock;
    const events = await import(`../lib/events.mjs?t=${Date.now()}`);
    const seen = [];
    await new Promise((resolve) => {
      const first = events.watchPaneStatus("w1:p1", {
        onReady: () => seen.push("ready1"),
        onStatus: (status) => seen.push(`status:${status}`),
        onProtocolError: (e) => seen.push(`protocol:${e.code}`),
        onError: (e) => seen.push(`error:${e.code}`),
        onClose: () => {
          seen.push("closed1");
          // 调用方按官方建议恢复：重订阅（恢复后的补查/推送随后到）
          events.watchPaneStatus("w1:p1", {
            onReady: () => seen.push("ready2"),
            onStatus: (status) => {
              seen.push(`status:${status}`);
              resolve();
            },
            onError: (e) => seen.push(`error2:${e.code}`),
          });
        },
      });
      void first;
    });
    server.close();
    const seq = seen.join(" → ");
    check(
      "Part1: events_lost 行经 onProtocolError 上报，随后 onClose；重订阅后照常收事件",
      seq === "ready1 → status:working → protocol:events_lost → closed1 → ready2 → status:idle",
      seq,
    );
  }

  // ================= Part 2：wait_for_worker 自动重订阅 =================
  {
    const state = join(home, "state2");
    const config = join(home, "config2");
    mkdirSync(state, { recursive: true });
    mkdirSync(config, { recursive: true });
    const fake = setupFakeHerdr(home, { hostWorkspace: false });
    const transcript = join(home, "transcript2.jsonl");
    writePiTranscript(transcript, []); // 0 轮：wait 发起时 worker 还在跑

    // 一个「active worker」的完整假现场：pane 带 agent，agent get 报 idle/seq=2。
    {
      const s = JSON.parse(readFileSync(fake.statePath, "utf8"));
      s.workspaces.wW = { workspace_id: "wW", label: "probe", kind: "plain", agent_status: "working" };
      s.tabs["wW:t1"] = { tab_id: "wW:t1", workspace_id: "wW", label: "1" };
      s.panes["wW:p1"] = {
        pane_id: "wW:p1",
        tab_id: "wW:t1",
        workspace_id: "wW",
        foreground_cwd: home,
        agent_status: "working",
        agent: true,
        report_agent_status: "idle",
        report_seq: 2,
      };
      writeFileSync(fake.statePath, JSON.stringify(s, null, 2));
    }
    // registry 预置 worker 行：dispatch_seq=2 与 fake 的 seq 持平——即使 transcript
    // 解析走降级判据，第一次补查也【不会】落定（这是拖到 events_lost 发生的前提）。
    writeFileSync(
      join(state, "registry.json"),
      JSON.stringify({
        version: 2,
        sessions: {
          k1: {
            key: "k1",
            slug: "lostw",
            role: "worker",
            root: "orc-lost",
            pane_id: "wW:p1",
            status: "active",
            harness: "pi",
            dispatch_turns: 0,
            dispatch_seq: 2,
            created_at: new Date().toISOString(),
          },
        },
        orchestrations: { "orc-lost": { root: "orc-lost" } },
      }),
    );

    const sock = join(home, "p2.sock");
    const { server, state: sockState } = await startScriptedSocket(sock, (n, client, msg) => {
      if (n === 1) {
        // 第一次订阅：events_lost 然后关流
        setTimeout(() => {
          client.write(JSON.stringify({ id: msg.id, error: { code: "events_lost", message: "event subscription fell behind retained history" } }) + "\n");
        }, 100);
        setTimeout(() => client.destroy(), 200);
      } else {
        // 恢复后的订阅：推 idle（延时留给测试主进程推进 transcript）
        setTimeout(() => {
          client.write(
            JSON.stringify({ event: "pane.agent_status_changed", data: { agent: "pi", agent_status: "idle", pane_id: "wW:p1", workspace_id: "wW" } }) + "\n",
          );
        }, 800);
      }
    });

    const ENV = {
      HERDGENT_HOME: home,
      HERDGENT_STATE_DIR: state,
      HERDGENT_CONFIG_DIR: config,
      HERDR_BIN_PATH: fake.bin,
      HERDR_SOCKET_PATH: sock,
      HG_FAKE_HERDR_STATE: fake.statePath,
      HG_FAKE_TRANSCRIPT: transcript,
      HG_WAIT_CEILING_MS: "20000",
    };

    // ---- 2a：一次 events_lost → 自动重订阅 → 照常 settled ----
    const probe = mcpProbe({
      args: ["--root", "orc-lost"],
      env: ENV,
      calls: [{ key: "wait", name: "wait_for_worker", arguments: { worker_ids: ["lostw"] } }],
    });
    // 第二次订阅的推送前（t≈ ack+400ms），把 transcript 推进到 1 轮
    await sleep(700);
    writePiTranscript(transcript, ["这一轮完工"]);
    const r2a = await probe;
    check("2a: wait 返回", !r2a.wait?.rpcError, JSON.stringify(r2a.wait).slice(0, 200));
    let body = r2a.wait?.body ?? r2a.wait ?? {};
    check(
      "2a: events_lost 后自动重订阅，worker 照常 settled（不落 unreachable）",
      (body.settled ?? []).some((x) => x.worker_id === "lostw" && x.status === "idle") && !("unreachable" in body),
      JSON.stringify(body).slice(0, 240),
    );
    check("2a: 确实发生了重订阅（订阅计数=2）", sockState.subs === 2, `subs=${sockState.subs}`);

    // ---- 2b：连续丢失超上限 → 落 unreachable，不无限自愈 ----
    // 2a 已把 worker 的 transcript 推进到 1 轮——2b 要让他【落不定】：把基线抬到
    // 5 轮（transcript 只有 1 轮），否则重订阅的 onReady 补查会立刻 settle，
    // 根本走不到 events_lost。
    {
      const reg = JSON.parse(readFileSync(join(state, "registry.json"), "utf8"));
      reg.sessions.k1.dispatch_turns = 5;
      writeFileSync(join(state, "registry.json"), JSON.stringify(reg, null, 2));
    }
    await closeServer(server);
    const sock2 = join(home, "p2b.sock");
    const always = await startScriptedSocket(sock2, (n, client, msg) => {
      setTimeout(() => {
        client.write(JSON.stringify({ id: msg.id, error: { code: "events_lost", message: "fell behind again" } }) + "\n");
      }, 60);
      setTimeout(() => client.destroy(), 120);
    });
    const r2b = await mcpProbe({
      args: ["--root", "orc-lost"],
      env: { ...ENV, HERDR_SOCKET_PATH: sock2 },
      calls: [{ key: "wait", name: "wait_for_worker", arguments: { worker_ids: ["lostw"] } }],
    });
    const body2 = r2b.wait?.body ?? r2b.wait ?? {};
    check(
      "2b: 连续 events_lost 超上限 → unreachable（reason 点名 events_lost），不无限自愈",
      (body2.unreachable ?? []).some((x) => x.worker_id === "lostw" && /events_lost/.test(x.reason ?? "")) &&
        (body2.settled ?? []).length === 0,
      JSON.stringify(body2).slice(0, 240),
    );
    check("2b: 首次 + 2 次重试共 3 次订阅后放弃", always.state.subs === 3, `subs=${always.state.subs}`);
    await closeServer(always.server);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

async function closeServer(server) {
  await new Promise((r) => server.close(r));
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
