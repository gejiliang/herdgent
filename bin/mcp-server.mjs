#!/usr/bin/env node
// Herdgent 的编排工具通道：作为 orchestrator 会话的 stdio 子进程运行，随会话生死。
//
// 用法（写进 orchestrator 的 --mcp-config）：
//   node bin/mcp-server.mjs --root <orchestration-id> --state-dir <dir>
//
// state-dir 必须显式传：HERDR_PLUGIN_STATE_DIR 只注入插件命令，
// 【不会】传进插件启动的会话，而这个进程是被那个会话拉起来的（findings 第五节）。
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../lib/mcp.mjs";
import { watchPaneStatus } from "../lib/events.mjs";
import { herdr, tryHerdr } from "../lib/herdr.mjs";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const stateDirArg = flag("state-dir");
if (stateDirArg) process.env.HERDGENT_STATE_DIR = stateDirArg;

const registry = await import("../lib/registry.mjs");
const ROOT = flag("root", "adhoc");

// 日志【绝不能】走 stdout——那是 JSON-RPC 的信道，混进一行非协议内容就毁掉整个会话。
function log(line) {
  try {
    appendFileSync(join(registry.stateDir(), "mcp.log"), `${new Date().toISOString()} [${ROOT}] ${line}\n`);
  } catch {
    // 日志失败不值得中断服务
  }
}

const TOOLS = [
  {
    name: "ping",
    description: "Health check for the herdgent orchestration channel. Returns a fixed marker plus this orchestration's id.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({ ok: true, marker: "HERDGENT_MCP_ALIVE", root: ROOT, pid: process.pid }),
  },
  {
    name: "herdr_status",
    description: "Check that herdr itself is reachable from this orchestration channel. Returns the current workspace count.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const r = tryHerdr(["workspace", "list"]);
      if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
      return { ok: true, workspaces: (r.result.workspaces || []).length };
    },
  },
  {
    name: "watch_pane_status",
    description:
      "Block until the agent in the given pane reaches a settled state (done, idle, or blocked), then return it. Used to verify the event pipeline; wait_for_worker will build on this.",
    inputSchema: {
      type: "object",
      properties: {
        pane_id: { type: "string", description: "Pane to watch, e.g. w1:p1" },
        timeout_s: { type: "number", description: "Give up after this many seconds (default 120)" },
      },
      required: ["pane_id"],
    },
    handler: (args) => waitForSettled(args.pane_id, Number(args.timeout_s) || 120),
  },
];

const SETTLED = new Set(["done", "idle", "blocked"]);

// 「先订阅、再补查」：订阅建立完成之前发生的状态变化不会被推送，
// 直接等事件会漏掉「调用时其实已经结束了」这种情况，然后一直等到超时。
function waitForSettled(paneId, timeoutS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sub.close();
      } catch {
        // 已经断了
      }
      fn(v);
    };

    const timer = setTimeout(
      () => finish(resolve, { settled: false, reason: "timeout", pane_id: paneId }),
      timeoutS * 1000,
    );

    const sub = watchPaneStatus(paneId, {
      onReady: () => {
        // 补查一次当前状态，填掉订阅建立前的空窗。
        const r = tryHerdr(["agent", "get", paneId]);
        if (r.ok) {
          const st = r.result.agent?.agent_status;
          if (SETTLED.has(st)) finish(resolve, { settled: true, status: st, pane_id: paneId, via: "poll" });
        }
      },
      onStatus: (status) => {
        if (SETTLED.has(status)) finish(resolve, { settled: true, status, pane_id: paneId, via: "event" });
      },
      onError: (e) => finish(reject, Object.assign(new Error(e.message), { code: e.code })),
      // 连接断开不能当作「等到了」——那会让调用方以为 worker 完成了。
      onClose: () =>
        finish(resolve, { settled: false, reason: "event_stream_closed", pane_id: paneId }),
    });
  });
}

createServer({ name: "herdgent", version: "0.0.1", tools: TOOLS, onLog: log });
