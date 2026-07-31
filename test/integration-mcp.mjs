#!/usr/bin/env node
// 端到端：以真实的 MCP 客户端身份驱动 bin/mcp-server.mjs，跑通
// spawn → wait → read → cancel 全链路。
//
// 【需要真的 herdr server 和真的 harness】，不进 npm test。按隔离配方跑：
//   HERDR_SOCKET_PATH=~/.config/herdr/sessions/herdgentdev/herdr.sock \
//   node test/integration-mcp.mjs
//
// 走协议而不是直接 import 函数：这样测的是 orchestrator 真正会看到的接口。
import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

const REPO = process.env.HG_REPO || process.cwd();
const STATE = "/tmp/hg-mcp-test";
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

// ---- 最小 MCP 客户端 ----
const proc = spawn(process.execPath, [SERVER, "--root", "mcp-probe", "--state-dir", STATE, "--repo", REPO, "--max-workers", "2"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});
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

// 工具的返回值包在 content[0].text 里，且我们统一 JSON 化了
async function callTool(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args, _meta: { progressToken: nextId } });
  const text = r.content?.[0]?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { isError: !!r.isError, ...parsed };
}

const spawned = [];
try {
  // ---- 握手 ----
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  check("initialize 回显协议版本", init.protocolVersion === "2025-06-18", init.protocolVersion);
  check("serverInfo 正确", init.serverInfo?.name === "herdgent");

  const { tools } = await rpc("tools/list", {});
  const names = tools.map((t) => t.name).sort();
  check("工具齐全", names.length === 8, names.join(","));

  const ping = await callTool("ping");
  check("ping", ping.marker === "HERDGENT_MCP_ALIVE" && ping.root === "mcp-probe");

  // ---- spawn ----
  for (const [i, title] of [["1", "probe-alpha"], ["2", "probe-beta"]]) {
    const r = await callTool("spawn_worker", {
      title,
      task: `Reply with exactly the token CYCLE_OK_${i} and nothing else.`,
      purpose: "explore",
      branch: `hg-mcp-${i}`,
    });
    check(`spawn ${title}`, !r.isError && !!r.worker_id, r.isError ? r.message : `${r.worker_id} ws=${r.workspace_id}`);
    if (r.worker_id) spawned.push(r);
  }

  const listed = await callTool("list_workers");
  check("list_workers 数目正确", listed.workers?.length === 2, `${listed.workers?.length}`);
  check("list_workers 报告闸值", listed.limit === 2, `limit=${listed.limit}`);

  // ---- 并发闸 ----
  const third = await callTool("spawn_worker", { title: "probe-gamma", task: "Reply OK." });
  check("超过闸值被拒", third.isError && third.error === "worker_limit_reached", third.error || "未被拒");

  // ---- wait ----
  const t0 = Date.now();
  const waited = await callTool("wait_for_worker");
  const ms = Date.now() - t0;
  check("wait 返回 settled", (waited.settled?.length ?? 0) > 0, JSON.stringify(waited.settled));
  check("wait 不是靠超时兜底", ms < 180000, `${ms}ms`);

  // ---- read ----
  for (const w of spawned) {
    // worker 可能还没跑完，等一轮再读
    await callTool("wait_for_worker", { worker_ids: [w.worker_id] }).catch(() => {});
    const r = await callTool("read_worker", { worker_id: w.worker_id });
    const got = String(r.text || "");
    check(`read ${w.title} 拿到结果`, !r.isError && got.includes("CYCLE_OK"), r.isError ? r.message : got.slice(0, 60));
  }

  const screen = await callTool("read_worker", { worker_id: spawned[0].worker_id, mode: "screen", lines: 20 });
  check("read screen 模式", !screen.isError && String(screen.screen || "").length > 0);

  // ---- send + interrupt：中断只停当前一轮，worker 应当还能接活 ----
  const victim = spawned[0].worker_id;
  const sent = await callTool("send_to_worker", {
    worker_id: victim,
    text: "Write a detailed 600-word essay about terminal emulators. Start now.",
  });
  check("send_to_worker 确认已提交", !sent.isError && sent.submitted === true, JSON.stringify(sent));

  await new Promise((r) => setTimeout(r, 6000)); // 让它真的忙起来
  const interrupted = await callTool("cancel_worker", { worker_id: victim, mode: "interrupt" });
  check("interrupt 后 worker 仍活着", !interrupted.isError && interrupted.alive === true, JSON.stringify(interrupted));

  const reused = await callTool("send_to_worker", {
    worker_id: victim,
    text: "Reply with exactly the token REUSED_OK and nothing else.",
  });
  check("中断后可以继续派活", !reused.isError && reused.submitted === true, JSON.stringify(reused));
  await callTool("wait_for_worker", { worker_ids: [victim] }).catch(() => {});
  const afterReuse = await callTool("read_worker", { worker_id: victim });
  check("复用后拿到新结果", String(afterReuse.text || "").includes("REUSED_OK"), String(afterReuse.text || "").slice(0, 60));

  // ---- 归属边界 ----
  const foreign = await callTool("read_worker", { worker_id: "definitely-not-mine" });
  check("外部 worker 查无此人", foreign.isError && foreign.error === "worker_not_found", foreign.error);
} finally {
  // ---- 回收 ----
  for (const w of spawned) {
    await callTool("cancel_worker", { worker_id: w.worker_id, mode: "terminate" }).catch(() => {});
  }
  proc.stdin.end();
  const leftover = execFileSync("git", ["branch", "--list", "hg-mcp-*"], { cwd: REPO, encoding: "utf8" }).trim();
  check("无残留分支", leftover === "", leftover);
  rmSync(STATE, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
