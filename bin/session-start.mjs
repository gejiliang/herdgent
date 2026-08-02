#!/usr/bin/env node
// Herdgent action：起一个独立的受管会话（不属于任何编排）。
//
// 归属边界是结构性的，不是过滤器：我们只操作自己建出来的 workspace，
// 从不按 label/agent 去全局搜——GG 手起的会话因此永远不在射程内。
//
// 这条路径也走 profile——profile 是「用什么跑」的唯一真源，编排的 spawn_worker
// 只认它，独立会话没有例外。早先这里不传 harness/model/yolo/effort/prompt，
// 起的是裸 claude：没 yolo 一动手就卡权限询问，没 system prompt，没思考等级。
import { startManagedSession } from "../lib/worker.mjs";
import { applyProfile, sessionStartProfile } from "../lib/profiles.mjs";

const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
// CLI 触发时 context 里【没有】 workspace_cwd / focused_pane_cwd，只有 correlation_id
// 和 invocation_source（实测，findings 8.2）。所以 fallback 是必需的，不是保险。
const cwd = ctx.focused_pane_cwd || ctx.workspace_cwd || process.env.PWD || process.cwd();
const task = process.argv[2] || "You are running under herdgent. Reply READY and wait for instructions.";

// plugin action invoke 没有传参机制，profile 只能从 herdr 注入的插件配置目录读
// （lib/profiles.mjs 的 sessionStartProfile）。applyProfile 在起会话【之前】校验：
// 配置里写了不存在的 profile 名会在这里抛 unknown_profile，绝不静默退回裸 claude。
const spec = applyProfile({ profile: sessionStartProfile(process.env.HERDR_PLUGIN_CONFIG_DIR) });

const entry = startManagedSession({
  cwd,
  task,
  role: "standalone",
  harness: spec.harness,
  model: spec.model,
  effort: spec.effort,
  yolo: spec.yolo,
  readOnly: spec.read_only,
  prompt: spec.prompt,
});
console.log(JSON.stringify({ started: entry }, null, 2));
