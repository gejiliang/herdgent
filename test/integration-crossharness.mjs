#!/usr/bin/env node
// 跨 harness 验收：同一套动词能不能同时驱动 claude 和 codex。
//
// 【需要真的 herdr server 和两家 CLI】，不进 npm test：
//   HERDR_SOCKET_PATH=~/.config/herdr/sessions/herdgentdev/herdr.sock \
//   node test/integration-crossharness.mjs
//
// 这是 herdgent 存在的理由：只有一家的话 Claude Code 自己的 dynamic workflow 就够了。
import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

const REPO = process.env.HG_REPO || process.cwd();
const STATE = "/tmp/hg-cross-test";
const SERVER = resolve(import.meta.dirname, "../bin/mcp-server.mjs");

if (!process.env.HERDR_SOCKET_PATH) {
  console.error("refusing to run without HERDR_SOCKET_PATH — this must not touch the default session");
  process.exit(2);
}
rmSync(STATE, { recursive: true, force: true });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const proc = spawn(
  process.execPath,
  [SERVER, "--root", "cross-probe", "--state-dir", STATE, "--repo", REPO, "--max-workers", "4"],
  { stdio: ["pipe", "pipe", "pipe"], env: process.env },
);
proc.stderr.on("data", (d) => console.error("[server stderr]", String(d).trim()));

let nextId = 1;
const pending = new Map();
let buf = "";
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.code}: ${msg.error.message}`)) : res(msg.result);
    }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function callTool(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args, _meta: { progressToken: nextId } });
  const text = r.content?.[0]?.text ?? "";
  try {
    return { isError: !!r.isError, ...JSON.parse(text) };
  } catch {
    return { isError: !!r.isError, raw: text };
  }
}

const spawned = [];
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const ping = await callTool("ping");
  check("两家 harness 都注册了", JSON.stringify(ping.harnesses) === '["claude","codex"]', JSON.stringify(ping.harnesses));

  const bogus = await callTool("spawn_worker", { title: "nope", task: "x", harness: "gemini" });
  check("未知 harness 被拒", bogus.isError && bogus.error === "unsupported_harness", bogus.error);

  // 两家各起一个：claude 带 worktree（实现类），codex 不带（只读类）
  const cases = [
    { harness: "claude", title: "cross-claude", branch: "hg-cross-claude", token: "CLAUDE_SIDE_OK" },
    { harness: "codex", title: "cross-codex", branch: null, token: "CODEX_SIDE_OK" },
  ];
  for (const c of cases) {
    const r = await callTool("spawn_worker", {
      title: c.title,
      harness: c.harness,
      task: `Reply with exactly the token ${c.token} and nothing else.`,
      purpose: "explore",
      ...(c.branch ? { branch: c.branch } : {}),
      yolo: true,
    });
    check(`spawn ${c.harness}`, !r.isError && !!r.worker_id, r.isError ? r.message : `${r.worker_id}`);
    if (r.worker_id) spawned.push({ ...c, worker_id: r.worker_id });
  }

  const listed = await callTool("list_workers");
  const kinds = (listed.workers || []).map((w) => w.harness).sort();
  check("登记表记录了各自的 harness", JSON.stringify(kinds) === '["claude","codex"]', JSON.stringify(kinds));

  // 逐个等 + 读。两家的 transcript 定位与解析路径完全不同。
  for (const w of spawned) {
    await callTool("wait_for_worker", { worker_ids: [w.worker_id] }).catch(() => {});
    let r = await callTool("read_worker", { worker_id: w.worker_id });
    // codex 的 session id 由 herdr 上报，可能比 spawn 晚几秒
    for (let i = 0; i < 6 && r.isError; i += 1) {
      await new Promise((s) => setTimeout(s, 5000));
      r = await callTool("read_worker", { worker_id: w.worker_id });
    }
    check(
      `read ${w.harness} 拿到结果`,
      !r.isError && String(r.text || "").includes(w.token),
      r.isError ? `${r.error}: ${r.message}` : String(r.text).slice(0, 50),
    );
    check(`${w.harness} 结果标了 harness`, r.harness === w.harness, r.harness);
  }

  // 提交语义：claude 要补 enter，codex 自动提交——同一个工具必须都能确认送达
  for (const w of spawned) {
    const sent = await callTool("send_to_worker", {
      worker_id: w.worker_id,
      text: `Reply with exactly the token SECOND_${w.harness.toUpperCase()} and nothing else.`,
    });
    check(`send_to_worker 在 ${w.harness} 上确认送达`, !sent.isError && sent.submitted === true, JSON.stringify(sent));
  }
} finally {
  for (const w of spawned) {
    await callTool("cancel_worker", { worker_id: w.worker_id, mode: "terminate" }).catch(() => {});
  }
  proc.stdin.end();
  const leftover = execFileSync("git", ["branch", "--list", "hg-cross-*"], { cwd: REPO, encoding: "utf8" }).trim();
  check("无残留分支", leftover === "", leftover);
  rmSync(STATE, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
