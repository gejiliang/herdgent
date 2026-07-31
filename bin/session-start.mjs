#!/usr/bin/env node
// Herdgent action：起一个受管会话。
//
// 归属边界是结构性的，不是过滤器：我们只操作自己 create 出来的 workspace，
// 从不按 label/agent 去全局搜——GG 手起的会话因此永远不在射程内。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdr, tryHerdr, waitForShell, startAgentWhenReady } from "../lib/herdr.mjs";
import * as registry from "../lib/registry.mjs";

const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
const cwd = ctx.focused_pane_cwd || ctx.workspace_cwd || process.env.PWD || process.cwd();
const task = process.argv[2] || "You are running under herdgent. Reply READY and wait for instructions.";

// agent 名受 herdr 约束：小写字母开头，只含 [a-z0-9-_]，1-32 字符。
// 所以用 base36 短 slug，不用 ISO 时间戳（带大写 T/Z 且超长）。
const slug = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const pendingKey = `pending:${slug}`;
const label = `herdgent-${slug}`;
const agentName = `herdgent-${slug}`;

const ws = herdr(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
const paneId = ws.root_pane.pane_id;
waitForShell(paneId);

// 控制面经启动 argv 注入。实测 Claude Code 的 --settings 与用户 settings 是【合并】语义：
// 我们注入的 SessionStart 与 herdr 自己的 SessionStart 同时生效（herdr 仍能填 agent_session）。
const sessionDir = join(registry.stateDir(), "sessions", slug);
mkdirSync(sessionDir, { recursive: true });
const settingsPath = join(sessionDir, "settings.json");
const hookPath = join(import.meta.dirname, "hook-claude.mjs");
const hookCmd = `${process.execPath} ${hookPath} ${pendingKey} --state-dir ${registry.stateDir()}`;
writeFileSync(
  settingsPath,
  JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCmd }] }] } }, null, 2),
);

// 登记必须【先于】起 agent：SessionStart 钩子在 `agent start` 执行期间就会回调，
// 若此时登记表里还没有这条记录，钩子只能记一条 miss，session id 就丢了。
registry.put({
  key: pendingKey,
  slug,
  harness: "claude",
  agent_name: agentName,
  workspace_label: label,
  // 下面这些是【当时的】句柄，重启后会变，仅用于本次寻址，不作主键
  workspace_id: ws.workspace.workspace_id,
  pane_id: paneId,
  cwd,
  task,
  status: "starting",
  created_at: new Date().toISOString(),
  settings_path: settingsPath,
});

// 必须带初始 prompt：裸跑 `claude` 落在会话面板首页，那里 herdr 的状态检测看不见任何变化，
// 而 prompt 又确实会被提交 —— 编排层会以为什么都没发生，实际有会话在无人看管地跑。
let started;
try {
  started = startAgentWhenReady([
    "agent", "start", agentName,
    "--kind", "claude",
    "--pane", paneId,
    "--", "--settings", settingsPath, task,
  ]);
} catch (e) {
  // 起不来就把自己建的 workspace 收回去，否则每次失败都在用户界面里留一个空壳。
  const cleanup = tryHerdr(["workspace", "close", ws.workspace.workspace_id]);
  const note = cleanup.ok ? "workspace reclaimed" : `workspace ${ws.workspace.workspace_id} LEAKED (${cleanup.code})`;
  const reg = registry.load();
  const entry = Object.values(reg.sessions).find((s) => s.slug === slug);
  if (entry) {
    entry.status = "failed";
    entry.failure = `${e.code}: ${e.message}`;
    registry.save(reg);
  }
  console.error(`herdgent: agent start failed (${e.code}); ${note}`);
  throw e;
}

// 钩子可能已经把 pending: 键换成了 claude:<uuid>，所以按 slug 找回自己那条，不按键。
const reg = registry.load();
const entry = Object.values(reg.sessions).find((s) => s.slug === slug);
const key = entry?.key ?? pendingKey;
reg.sessions[key] = {
  ...(entry ?? {}),
  key,
  status: "active",
  // herdr 侧也报告了 harness session id；两个来源应当一致，不一致时以钩子为准并留痕。
  herdr_reported_session_id: started.agent?.agent_session?.value ?? null,
  harness_session_id: entry?.harness_session_id ?? started.agent?.agent_session?.value ?? null,
};
registry.save(reg);

console.log(JSON.stringify({ started: reg.sessions[key] }, null, 2));
