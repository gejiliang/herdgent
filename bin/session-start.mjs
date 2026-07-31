#!/usr/bin/env node
// Herdgent action：起一个独立的受管会话（不属于任何编排）。
//
// 归属边界是结构性的，不是过滤器：我们只操作自己建出来的 workspace，
// 从不按 label/agent 去全局搜——GG 手起的会话因此永远不在射程内。
import { startManagedSession } from "../lib/worker.mjs";

const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
// CLI 触发时 context 里【没有】 workspace_cwd / focused_pane_cwd，只有 correlation_id
// 和 invocation_source（实测，findings 8.2）。所以 fallback 是必需的，不是保险。
const cwd = ctx.focused_pane_cwd || ctx.workspace_cwd || process.env.PWD || process.cwd();
const task = process.argv[2] || "You are running under herdgent. Reply READY and wait for instructions.";

const entry = startManagedSession({ cwd, task, role: "standalone" });
console.log(JSON.stringify({ started: entry }, null, 2));
