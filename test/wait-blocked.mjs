#!/usr/bin/env node
// blocked 是「需要人介入」的落定：agent get 报 blocked 的 worker，
// wait_for_worker 必须快速落定成 blocked（不等 turns、不挂兜底上限），
// 编排者拿 waitFailureReason 的指引去应答。
// 回归：2026-09-22 非 yolo claude 的信任框曾把 run_plan 挂到 30 分钟上限。
//
// 隔离是结构性的：fake herdr CLI + 假事件 socket，根本连不上真 herdr。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFakeHerdr, startEventSocket, closeSocket, writePiTranscript, mcpProbe } from "./fake-herdr.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-wait-blocked-"));
const state = join(home, "state");
const config = join(home, "config");
mkdirSync(state, { recursive: true });
mkdirSync(config, { recursive: true });
const fake = setupFakeHerdr(home, { hostWorkspace: false });
const transcript = join(home, "transcript.jsonl");
writePiTranscript(transcript, []); // 0 轮：blocked 的 worker 没有任何新产出

// 一个「卡在信任框」的 worker 现场：pane 带 agent，agent get 报 blocked。
{
  const s = JSON.parse(readFileSync(fake.statePath, "utf8"));
  s.workspaces.wB = { workspace_id: "wB", label: "probe", kind: "plain", agent_status: "blocked" };
  s.tabs["wB:t1"] = { tab_id: "wB:t1", workspace_id: "wB", label: "1" };
  s.panes["wB:p1"] = {
    pane_id: "wB:p1",
    tab_id: "wB:t1",
    workspace_id: "wB",
    foreground_cwd: home,
    agent_status: "blocked",
    agent: true,
    report_agent_status: "blocked",
    report_seq: 3,
  };
  writeFileSync(fake.statePath, JSON.stringify(s, null, 2));
}
writeFileSync(
  join(state, "registry.json"),
  JSON.stringify({
    version: 2,
    sessions: {
      k1: {
        key: "k1",
        slug: "blockedw",
        role: "worker",
        root: "orc-blocked",
        pane_id: "wB:p1",
        status: "active",
        harness: "claude",
        dispatch_turns: 0,
        dispatch_seq: 3,
        created_at: new Date().toISOString(),
      },
    },
    orchestrations: { "orc-blocked": { root: "orc-blocked" } },
  }),
);

const socket = join(home, "events.sock");
const socketServer = await startEventSocket(socket);

const ENV = {
  HERDGENT_HOME: home,
  HERDGENT_STATE_DIR: state,
  HERDGENT_CONFIG_DIR: config,
  HERDR_BIN_PATH: fake.bin,
  HERDR_SOCKET_PATH: socket,
  HG_FAKE_HERDR_STATE: fake.statePath,
  HG_FAKE_TRANSCRIPT: transcript,
  HG_WAIT_CEILING_MS: "60000", // 挂了也只能挂 60s；修复后应是秒级返回
};

try {
  const t0 = Date.now();
  const r = await mcpProbe({
    args: ["--root", "orc-blocked"],
    env: ENV,
    calls: [{ key: "wait", name: "wait_for_worker", arguments: { worker_ids: ["blockedw"] } }],
  });
  const ms = Date.now() - t0;
  const body = r.wait ?? {};
  check(
    "blocked 的 worker 快速落定成 blocked（不挂上限）",
    (body.settled ?? []).some((x) => x.worker_id === "blockedw" && x.status === "blocked") && ms < 30000,
    `${ms}ms ${JSON.stringify(body).slice(0, 200)}`,
  );
  const reg = JSON.parse(readFileSync(join(state, "registry.json"), "utf8"));
  check("registry 写回 agent_status=blocked", reg.sessions.k1.agent_status === "blocked", reg.sessions.k1.agent_status);
} finally {
  await closeSocket(socketServer);
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
