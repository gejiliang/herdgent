#!/usr/bin/env node
// 身份自判验收：MCP server 从三条路启动时，认不认得出自己是谁。
//
// 不需要 herdr server（只读 registry + 走协议），所以进 npm test。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(import.meta.dirname, "../bin/mcp-server.mjs");
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// 起一个 MCP server，握手 + 列工具 + ping，然后关掉。
function probe({ args = [], env = {}, probeSpawn = false, calls = [] } = {}) {
  return new Promise((res, rej) => {
    const proc = spawn(process.execPath, [SERVER, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let buf = "";
    const out = {};
    const pending = new Map();
    let nextId = 1;
    const send = (method, params) => {
      const id = nextId++;
      return new Promise((r) => {
        pending.set(id, r);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    };
    proc.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    proc.on("error", rej);
    (async () => {
      await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      const tools = await send("tools/list", {});
      out.tools = (tools.result?.tools ?? []).map((t) => t.name).sort();
      const ping = await send("tools/call", { name: "ping", arguments: {} });
      out.ping = JSON.parse(ping.result?.content?.[0]?.text ?? "{}");

      out.calls = {};
      for (const call of calls) {
        const reply = await send("tools/call", { name: call.name, arguments: call.arguments ?? {} });
        const text = reply.result?.content?.[0]?.text ?? "{}";
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
        out.calls[call.key ?? call.name] = reply.result
          ? { isError: !!reply.result.isError, ...body }
          : { rpcError: reply.error };
      }

      // ⚠️ 只在【预期会被拒】的身份上调 spawn_worker。
      // 编排者身份下这个调用会【真的去建 workspace、真的起一个 agent】——
      // 曾经在这里翻过车：以为 HERDR_SOCKET_PATH="" 能让它连不上，
      // 但空字符串是 falsy，herdr CLI 于是连了 default session，
      // 在用户的工作区里留下 5 个探针会话。
      if (probeSpawn) {
        const spawnTry = await send("tools/call", {
          name: "spawn_worker",
          arguments: { title: "identity-probe", task: "must never actually run" },
        });
        out.spawnResult = spawnTry.result
          ? { isError: !!spawnTry.result.isError, ...JSON.parse(spawnTry.result.content?.[0]?.text ?? "{}") }
          : { rpcError: spawnTry.error };
      }
      proc.stdin.end();
      proc.kill();
      res(out);
    })().catch(rej);
  });
}

function fakeHerdr(dir) {
  const bin = join(dir, "fake-herdr.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.argv[2] === "agent" && process.argv[3] === "read") {
  process.stdout.write(process.env.HG_FAKE_SCREEN || "fake CLI screen\\n");
  process.exit(0);
}
const code = process.env.HG_FAKE_HERDR_CODE || "server_not_running";
process.stderr.write(JSON.stringify({ id: "fake", error: { code, message: "fake herdr error" } }) + "\\n");
process.exit(1);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

async function startReadSocket(socketPath, result, requests) {
  const server = createNetServer((client) => {
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      requests.push(request);
      client.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// 第二层保险：把 herdr socket 指向一个不存在的路径。即使将来某个断言写漏了，
// 也不可能连上真的 herdr 去建东西。测试【永远】不该有碰到 default session 的可能。
const DEAD_SOCKET = join(tmpdir(), "hg-identity-no-such-herdr.sock");

const state = mkdtempSync(join(tmpdir(), "hg-identity-"));
mkdirSync(state, { recursive: true });
const fakeBin = fakeHerdr(state);

// 造一张登记表：w9:p1 是某次编排的 worker
writeFileSync(
  join(state, "registry.json"),
  JSON.stringify({
    version: 2,
    sessions: {
      "claude:aaa": {
        key: "claude:aaa",
        slug: "wk1",
        role: "worker",
        root: "orc-test",
        title: "some-task",
        pane_id: "w9:p1",
        status: "active",
        harness: "claude",
      },
    },
    orchestrations: {
      "orc-test": {
        root: "orc-test",
        max_workers: 6,
        runs: {
          "run-t1": {
            run_id: "run-t1",
            root: "orc-test",
            status: "running",
            container: "worktree",
            workspace_id: "w8",
            stages: { t1: { label: "1 impl", step: "impl", status: "done", root_pane_id: "w8:p9" } },
          },
        },
      },
    },
  }),
);

try {
  // ---- 1. 裸终端（没有 HERDR_PANE_ID）：必然是编排者 ----
  const cli = await probe({
    env: { HERDGENT_STATE_DIR: state, HERDR_PANE_ID: "", HERDR_SOCKET_PATH: DEAD_SOCKET },
  });
  check("CLI 直连被判为编排者", cli.ping.role === "orchestrator", cli.ping.role);
  check("root 绑在项目上", String(cli.ping.root).startsWith("orc:repo:"), cli.ping.root);
  check("编排者拿得到 spawn_worker", cli.tools.includes("spawn_worker"));

  // ---- 1b. 【会话重启后 root 不变】----
  // 这是 root 绑项目而不是绑会话的全部理由：早先 root 取 harness session id，
  // GG 一重启会话上一轮的 worker 就全部落在射程外——list_workers 空数组，
  // 而 live_across_all_orchestrations 显示 1，看得见却碰不到。
  const restarted = await probe({
    env: { HERDGENT_STATE_DIR: state, HERDR_PANE_ID: "", HERDR_SOCKET_PATH: DEAD_SOCKET },
  });
  check("重启后 root 不变", restarted.ping.root === cli.ping.root, `${cli.ping.root} vs ${restarted.ping.root}`);

  // 同一个项目、不同 pane（herdr 里另开一个 tab）也该是同一次编排
  const otherPane = await probe({
    env: { HERDGENT_STATE_DIR: state, HERDR_PANE_ID: "w99:p1", HERDR_SOCKET_PATH: DEAD_SOCKET },
  });
  check("同项目另一个 pane 同 root", otherPane.ping.root === cli.ping.root, otherPane.ping.root);

  // 换个项目就该是另一次编排
  const elsewhere = await probe({
    args: ["--repo", tmpdir()],
    env: { HERDGENT_STATE_DIR: state, HERDR_PANE_ID: "", HERDR_SOCKET_PATH: DEAD_SOCKET },
  });
  check("换项目换 root", elsewhere.ping.root !== cli.ping.root, elsewhere.ping.root);

  // ---- 2. herdr 里的 worker pane：认出自己是 worker ----
  const worker = await probe({
    env: { HERDGENT_STATE_DIR: state, HERDR_PANE_ID: "w9:p1", HERDR_SOCKET_PATH: DEAD_SOCKET },
    probeSpawn: true, // 只有这个身份下 spawn 必被拒，才安全
  });
  check("worker pane 被判为 worker", worker.ping.role === "worker", worker.ping.role);
  check("worker 继承所属编排的 root", worker.ping.root === "orc-test", worker.ping.root);
  check("worker 的工具列表里没有 spawn_worker", !worker.tools.includes("spawn_worker"), worker.tools.join(","));
  // run_plan / run_preset 也要藏起来：它们内部会被 assertCanSpawn 拒，但列在表里
  // 会让 worker 排完一整个计划再撞墙，那一轮思考全白费。
  check(
    "worker 也看不到 run_plan / run_preset",
    !worker.tools.includes("run_plan") && !worker.tools.includes("run_preset"),
    worker.tools.join(","),
  );
  check("worker 仍保留只读工具", worker.tools.includes("read_worker") && worker.tools.includes("list_workers"));
  // 两层防护，任一生效即可：
  //   外层——工具压根没注册，MCP 直接 -32602 unknown tool（实际走的是这层）
  //   内层——assertCanSpawn 抛 workers_cannot_spawn（万一某天工具又被注册上）
  const refused =
    worker.spawnResult.rpcError?.code === -32602 ||
    (worker.spawnResult.isError && worker.spawnResult.error === "workers_cannot_spawn");
  check("worker 硬调 spawn_worker 被拒", refused, JSON.stringify(worker.spawnResult).slice(0, 90));

  // ---- 3. 显式 --root（逃生口：把一次编排钉死在给定 id 上）----
  const explicit = await probe({
    args: ["--root", "orc-explicit"],
    env: { HERDGENT_STATE_DIR: state, HERDR_PANE_ID: "w9:p1", HERDR_SOCKET_PATH: DEAD_SOCKET },
  });
  check("显式 --root 优先于自动推导", explicit.ping.root === "orc-explicit", explicit.ping.root);
  check("显式 --root 时是编排者", explicit.ping.role === "orchestrator", explicit.ping.role);

  // ---- 4. screen 读取优先走 socket，透出 herdr 自己的截断标志 ----
  const readSocket = join(state, "agent-read.sock");
  const requests = [];
  const socketServer = await startReadSocket(readSocket, { text: "socket screen", truncated: true }, requests);
  try {
    const screen = await probe({
      args: ["--root", "orc-test"],
      env: {
        HERDGENT_STATE_DIR: state,
        HERDR_SOCKET_PATH: readSocket,
        HERDR_BIN_PATH: fakeBin,
        HG_FAKE_SCREEN: "CLI must not be used\\n",
      },
      calls: [{ key: "screen", name: "read_worker", arguments: { worker_id: "wk1", mode: "screen", lines: 27 } }],
    });
    check("screen 读取透出 herdr_truncated", screen.calls.screen.screen === "socket screen" && screen.calls.screen.herdr_truncated === true, JSON.stringify(screen.calls.screen));
    const request = requests[0];
    check(
      "screen socket 请求是 agent.read",
      request?.method === "agent.read" && request.params?.target === "w9:p1" && request.params?.source === "visible" && request.params?.lines === 27,
      JSON.stringify(request),
    );
  } finally {
    await closeServer(socketServer);
  }

  // socket 结果缺 metadata 时也必须走旧 CLI 路径，不能把残缺 response 当完整 screen。
  const incompleteSocket = join(state, "agent-read-incomplete.sock");
  const incompleteServer = await startReadSocket(incompleteSocket, { text: "missing metadata" }, []);
  try {
    const fallback = await probe({
      args: ["--root", "orc-test"],
      env: {
        HERDGENT_STATE_DIR: state,
        HERDR_SOCKET_PATH: incompleteSocket,
        HERDR_BIN_PATH: fakeBin,
        HG_FAKE_SCREEN: "CLI fallback",
      },
      calls: [{ key: "screen", name: "read_worker", arguments: { worker_id: "wk1", mode: "screen" } }],
    });
    check("screen 缺 truncated 时回退 CLI", fallback.calls.screen.screen === "CLI fallback" && fallback.calls.screen.herdr_truncated === null, JSON.stringify(fallback.calls.screen));
  } finally {
    await closeServer(incompleteServer);
  }

  // 不可连接 socket 也是降级，不可让诊断工具失效。
  const unavailable = await probe({
    args: ["--root", "orc-test"],
    env: {
      HERDGENT_STATE_DIR: state,
      HERDR_SOCKET_PATH: join(state, "no-such-agent-read.sock"),
      HERDR_BIN_PATH: fakeBin,
      HG_FAKE_SCREEN: "CLI after socket error",
    },
    calls: [{ key: "screen", name: "read_worker", arguments: { worker_id: "wk1", mode: "screen" } }],
  });
  check("screen socket 不可用时回退 CLI", unavailable.calls.screen.screen === "CLI after socket error" && unavailable.calls.screen.herdr_truncated === null, JSON.stringify(unavailable.calls.screen));

  // ---- 5. server_not_running 给状态和 spawn 一条准确的可操作错误 ----
  const noServer = await probe({
    args: ["--root", "orc-test"],
    env: {
      HERDGENT_STATE_DIR: state,
      HERDR_SOCKET_PATH: join(state, "no-such-herdr.sock"),
      HERDR_BIN_PATH: fakeBin,
      HG_FAKE_HERDR_CODE: "server_not_running",
    },
    calls: [
      { key: "status", name: "herdr_status" },
      // 裸 spawn 先撞归属校验——根本不碰 herdr，server 死不死都该是 run_id_required。
      { key: "bareSpawn", name: "spawn_worker", arguments: { title: "must-not-start", profile: "impl-glm", task: "must never run" } },
      // 带 run_id + step_id 的追加会走到建 pane 那一步，才遇得到 herdr。
      { key: "spawn", name: "spawn_worker", arguments: { run_id: "run-t1", step_id: "impl", title: "must-not-start", profile: "impl-glm", task: "must never run" } },
    ],
  });
  check("herdr_status 说明 server 没跑", noServer.calls.status.isError && noServer.calls.status.error === "server_not_running" && noServer.calls.status.message.includes("herdr server is not running"), JSON.stringify(noServer.calls.status));
  check("裸 spawn 被拒且指向 run_plan", noServer.calls.bareSpawn.isError && noServer.calls.bareSpawn.error === "run_id_required", JSON.stringify(noServer.calls.bareSpawn));
  check("追加 spawn 说明 server 没跑", noServer.calls.spawn.isError && noServer.calls.spawn.error === "server_not_running" && noServer.calls.spawn.message.includes("herdr server is not running"), JSON.stringify(noServer.calls.spawn));
} finally {
  rmSync(state, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
