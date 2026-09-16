// 测试共享脚手架：有状态的假 herdr（CLI + 事件 socket）与 MCP 探针。
//
// 这不是 herdr 的模拟框架，只是测试夹具：它实现的命令恰好覆盖
// run_plan / spawn_worker / finalize_run 三条路径所调的那些，
// 行为按 0.9.0 实测的返回形状写死。新调用的命令会撞 unexpected_call——
// 那是故意的：测试必须看得见代码对 herdr 的每一次调用。
//
// ⚠️ 结构性隔离继承 AGENTS.md 的铁律：假 herdr 经 HERDR_BIN_PATH 注入，
// 事件 socket 是测试自己 listen 的本地文件 socket——这个进程【根本连不上】真 herdr。
import { chmodSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

export const FAKE_HERDR_SOURCE = `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const statePath = process.env.HG_FAKE_HERDR_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { seq: 0, workspaces: {}, tabs: {}, panes: {}, primaries: {}, calls: [] };
state.primaries = state.primaries || {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
function ok(result) { process.stdout.write(JSON.stringify({ id: "fake", result }) + "\\n"); save(); process.exit(0); }
function fail(code, msg) { process.stderr.write(JSON.stringify({ id: "fake", error: { code, message: msg || "fake herdr error" } }) + "\\n"); save(); process.exit(1); }
const cmd = args[0] + " " + args[1];
const opt = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
const mkPane = (paneId, tabId, wsId, cwd) => {
  state.panes[paneId] = { pane_id: paneId, tab_id: tabId, workspace_id: wsId, foreground_cwd: cwd, agent_status: "unknown" };
};
const counts = (wsId) => ({
  tab_count: Object.values(state.tabs).filter((t) => t.workspace_id === wsId).length,
  pane_count: Object.values(state.panes).filter((p) => p.workspace_id === wsId).length,
});

if (cmd === "workspace create") {
  const n = ++state.seq;
  const wsId = "w" + n, tabId = wsId + ":t1", paneId = wsId + ":p1";
  const cwd = opt("--cwd");
  const ws = { workspace_id: wsId, label: opt("--label"), cwd: cwd, kind: "plain", agent_status: "unknown" };
  state.workspaces[wsId] = ws;
  state.tabs[tabId] = { tab_id: tabId, workspace_id: wsId, label: "1" };
  mkPane(paneId, tabId, wsId, cwd);
  if (cwd && !state.primaries[cwd]) state.primaries[cwd] = wsId;
  ok({ workspace: { workspace_id: wsId, label: ws.label }, tab: { tab_id: tabId }, root_pane: { pane_id: paneId, cwd: cwd } });
}
if (cmd === "worktree list") {
  // 0.9.0 实测形状：repo 有已打开的 primary 时带 source_workspace_id，否则字段缺失。
  const cwd = opt("--cwd");
  const source = { repo_root: cwd };
  if (cwd && state.primaries[cwd]) source.source_workspace_id = state.primaries[cwd];
  ok({ source: source, worktrees: [] });
}
if (cmd === "worktree create") {
  // 与 0.9.0 实测一致：--cwd 且该 repo 还没有 primary 时，【隐式多建一个】基础 workspace。
  let sourceId = opt("--workspace");
  const cwd = opt("--cwd");
  if (!sourceId && cwd) {
    sourceId = state.primaries[cwd] || null;
    if (!sourceId) {
      const m = ++state.seq;
      const baseId = "w" + m, bTab = baseId + ":t1";
      state.workspaces[baseId] = { workspace_id: baseId, label: "repo", cwd: cwd, kind: "plain", agent_status: "unknown" };
      state.tabs[bTab] = { tab_id: bTab, workspace_id: baseId, label: "1" };
      mkPane(baseId + ":p1", bTab, baseId, cwd);
      state.primaries[cwd] = baseId;
      sourceId = baseId;
    }
  }
  const repo = (sourceId && state.workspaces[sourceId]?.cwd) || cwd;
  if (repo && sourceId && !state.primaries[repo]) state.primaries[repo] = sourceId;
  const n = ++state.seq;
  const wsId = "w" + n, tabId = wsId + ":t1", paneId = wsId + ":p1";
  const ws = {
    workspace_id: wsId,
    label: opt("--label"),
    cwd: repo,
    kind: "worktree",
    primary: sourceId,
    branch: opt("--branch"),
    checkout_path: statePath + "-checkout-" + wsId,
  };
  state.workspaces[wsId] = ws;
  state.tabs[tabId] = { tab_id: tabId, workspace_id: wsId, label: ws.label };
  mkPane(paneId, tabId, wsId, ws.checkout_path);
  ok({ workspace: { workspace_id: wsId, label: ws.label, worktree: { checkout_path: ws.checkout_path } }, tab: { tab_id: tabId }, root_pane: { pane_id: paneId } });
}
if (cmd === "workspace get") {
  const ws = state.workspaces[args[2]];
  ws ? ok({ workspace: { ...ws, ...counts(args[2]) } }) : fail("workspace_not_found");
}
if (cmd === "workspace close") {
  // 0.9.0 实测：primary 还有 linked 子 workspace 时，herdr 自己拒关（group 守卫）。
  const wsId = args[2];
  if (!state.workspaces[wsId]) fail("workspace_not_found");
  if (Object.values(state.workspaces).some((w) => w.primary === wsId)) {
    fail("workspace_group_close_required", "workspace has linked worktree workspaces");
  }
  delete state.workspaces[wsId];
  for (const [id, t] of Object.entries(state.tabs)) if (t.workspace_id === wsId) delete state.tabs[id];
  for (const [id, p] of Object.entries(state.panes)) if (p.workspace_id === wsId) delete state.panes[id];
  for (const [k, v] of Object.entries(state.primaries)) if (v === wsId) delete state.primaries[k];
  ok({ type: "ok" });
}
if (cmd === "tab create") {
  const n = ++state.seq;
  const tabId = "t" + n, paneId = "p" + n;
  state.tabs[tabId] = { tab_id: tabId, workspace_id: opt("--workspace"), label: opt("--label") };
  state.panes[paneId] = { pane_id: paneId, tab_id: tabId, workspace_id: opt("--workspace") };
  ok({ tab: { tab_id: tabId }, root_pane: { pane_id: paneId } });
}
if (cmd === "tab rename") {
  const t = state.tabs[args[2]];
  if (t) t.label = args[3];
  t ? ok({ tab: t }) : fail("tab_not_found");
}
if (cmd === "tab list") {
  ok({ tabs: Object.values(state.tabs).filter((t) => t.workspace_id === opt("--workspace")) });
}
if (cmd === "tab close") {
  const t = state.tabs[args[2]];
  if (!t) fail("tab_not_found");
  delete state.tabs[args[2]];
  for (const [id, p] of Object.entries(state.panes)) if (p.tab_id === args[2]) delete state.panes[id];
  ok({});
}
if (cmd === "pane list") {
  ok({ panes: Object.values(state.panes).filter((p) => p.workspace_id === opt("--workspace")) });
}
if (cmd === "pane get") {
  const p = state.panes[args[2]];
  p ? ok({ pane: p }) : fail("pane_not_found");
}
if (cmd === "pane split") {
  const src = state.panes[args[2]];
  if (!src) fail("pane_not_found");
  const n = ++state.seq;
  const paneId = "p" + n;
  state.panes[paneId] = { pane_id: paneId, tab_id: src.tab_id, workspace_id: src.workspace_id };
  ok({ pane: { pane_id: paneId } });
}
if (cmd === "pane process-info") {
  ok({ process_info: { shell_pid: 42, foreground_processes: [{ name: "zsh" }] } });
}
if (cmd === "agent list") ok({ agents: [] });
if (cmd === "agent start") {
  // 测试开关：让 agent start 必败（非重试型错误码），走启动失败的回收路径。
  if (process.env.HG_FAKE_FAIL_AGENT_START) fail("agent_boom", "agent start disabled by test");
  const pane = opt("--pane");
  const p = state.panes[pane];
  if (!p) fail("pane_not_found");
  p.agent = true;
  p.agent_name = args[2];
  ok({ agent: { agent_status: "working", state_change_seq: 1, pane_id: pane, agent_session: { kind: "path", value: process.env.HG_FAKE_TRANSCRIPT } } });
}
if (cmd === "agent get") {
  const p = state.panes[args[2]];
  if (!p || !p.agent) fail("agent_not_found");
  ok({ agent: { agent_status: "done", state_change_seq: 2, pane_id: args[2], agent_session: { kind: "path", value: process.env.HG_FAKE_TRANSCRIPT } } });
}
if (cmd === "agent send-keys") ok({});
if (cmd === "agent read") { process.stdout.write("fake screen\\n"); save(); process.exit(0); }
if (cmd === "worktree remove") {
  // 顺序哨兵：破坏性动作发生的这一刻，结果日志里必须已有本次 attempt 的
  // in_progress 记录——「先落盘再动手」是可检验的，不是注释里的口号。
  const logPath = process.env.HG_FAKE_RUN_LOG;
  if (logPath) {
    let mark = "logcheck:unreadable";
    try {
      const log = JSON.parse(readFileSync(logPath, "utf8"));
      mark = (log.cleanup?.attempts ?? []).some((a) => a.status === "in_progress") ? "logcheck:in_progress" : "logcheck:no_in_progress";
    } catch { /* unreadable 保持 */
    }
    state.calls.push(mark);
  }
  const wsId = opt("--workspace");
  if (!state.workspaces[wsId]) fail("workspace_not_found");
  delete state.workspaces[wsId];
  for (const [id, t] of Object.entries(state.tabs)) if (t.workspace_id === wsId) delete state.tabs[id];
  for (const [id, p] of Object.entries(state.panes)) if (p.workspace_id === wsId) delete state.panes[id];
  ok({});
}
fail("unexpected_call", "fake herdr got: " + args.join(" "));
`;

// 写假 herdr 并预置编排者自己的 workspace（fox 的宿主）。返回路径与初始状态位置。
export function setupFakeHerdr(dir, { hostWorkspace = true } = {}) {
  const bin = join(dir, "fake-herdr.mjs");
  writeFileSync(bin, FAKE_HERDR_SOURCE);
  chmodSync(bin, 0o755);
  const statePath = join(dir, "fake-herdr-state.json");
  const seed = { seq: 0, workspaces: {}, tabs: {}, panes: {}, primaries: {}, calls: [] };
  if (hostWorkspace) {
    seed.workspaces.w0 = { workspace_id: "w0", label: "orchestrator-host", kind: "plain", agent_status: "unknown" };
    seed.tabs["w0:t0"] = { tab_id: "w0:t0", workspace_id: "w0", label: "main" };
    seed.panes["w0:p0"] = { pane_id: "w0:p0", tab_id: "w0:t0", workspace_id: "w0", foreground_cwd: null, agent_status: "unknown" };
  }
  writeFileSync(statePath, JSON.stringify(seed, null, 2));
  return { bin, statePath };
}

// 假事件 socket：events.subscribe 一律 ack，不推送——wait 的补查路径
// （onReady → agent get）已经足够让假环境里的 worker 落定。
export function startEventSocket(socketPath) {
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
        if (msg.id) client.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
      }
    });
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(socketPath, () => {
      server.off("error", rejectServer);
      resolveServer(server);
    });
  });
}

export function closeSocket(server) {
  return new Promise((r) => server.close(r));
}

// pi 的 transcript：一行一条 message，assistant 轮次即产出判据。
export function writePiTranscript(path, texts) {
  const lines = texts.map((t) =>
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: t }] } }),
  );
  writeFileSync(path, lines.join("\n") + "\n");
}

// 通用 MCP 探针：握手后按顺序调 tools/call，返回 { call.key: 解析后的正文 }。
export function mcpProbe({ calls, env = {}, args = [] }) {
  const SERVER = resolve(import.meta.dirname, "../bin/mcp-server.mjs");
  return new Promise((resolveProbe, rejectProbe) => {
    const proc = spawn(process.execPath, [SERVER, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let buffer = "";
    let nextId = 1;
    const pending = new Map();
    const send = (method, params) =>
      new Promise((resolveReply) => {
        const id = nextId++;
        pending.set(id, resolveReply);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const reply = JSON.parse(line);
        if (reply.id !== undefined && pending.has(reply.id)) {
          pending.get(reply.id)(reply);
          pending.delete(reply.id);
        }
      }
    });
    proc.on("error", rejectProbe);
    (async () => {
      await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      const out = {};
      for (const call of calls) {
        const reply = await send("tools/call", { name: call.name, arguments: call.arguments ?? {} });
        if (!reply.result) {
          out[call.key ?? call.name] = { rpcError: reply.error };
          continue;
        }
        const text = reply.result.content?.[0]?.text ?? "{}";
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
        out[call.key ?? call.name] = { isError: !!reply.result.isError, ...body };
      }
      proc.stdin.end();
      proc.kill();
      resolveProbe(out);
    })().catch((e) => {
      proc.kill();
      rejectProbe(e);
    });
  });
}
