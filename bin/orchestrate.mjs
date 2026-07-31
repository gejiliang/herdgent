#!/usr/bin/env node
// Herdgent action：起一个 orchestrator 会话，并把编排工具通道接上去。
//
// 为什么必须由 herdgent 起：MCP 配置只能在会话【启动时】注入，
// 已经跑着的会话加不了工具。所以编排不能在当前会话里就地开始。
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { herdr, tryHerdr, waitForShell, startAgentWhenReady } from "../lib/herdr.mjs";
import { reclaimSession } from "../lib/worker.mjs";
import * as registry from "../lib/registry.mjs";

const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
// CLI 触发时 context 里没有 workspace_cwd（实测 findings 8.2），fallback 是必需的。
const repo = ctx.focused_pane_cwd || ctx.workspace_cwd || process.env.PWD || process.cwd();

// 并发闸的启动值。plugin action invoke 没有传参机制，所以放插件配置里；
// 起会话之后 orchestrator 还能用 set_worker_limit 改，改完立刻生效。
function configuredLimit() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) return 6;
  try {
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    const n = Math.floor(Number(cfg.max_workers));
    return Number.isFinite(n) && n >= 1 && n <= 50 ? n : 6;
  } catch {
    return 6; // 没配置就用默认，不是错误
  }
}

const root = `orc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const maxWorkers = configuredLimit();
const label = root;

// 孤儿扫描：上一个 orchestrator 崩了，它派的 worker 可能还在跑。
// 【不自动杀】——杀正在干活的 agent 不可逆，列出来让人决定。
function findOrphans() {
  const rows = registry.list();
  const liveRoots = new Set(
    rows.filter((s) => s.role === "orchestrator" && s.status === "active").map((s) => s.root),
  );
  return rows.filter(
    (s) => s.role === "worker" && s.status === "active" && !liveRoots.has(s.root),
  );
}

const orphans = findOrphans();

const ws = herdr(["workspace", "create", "--cwd", repo, "--label", label, "--no-focus"]);
const paneId = ws.root_pane.pane_id;
const workspaceId = ws.workspace.workspace_id;

try {
  waitForShell(paneId);

  const sessionDir = join(registry.stateDir(), "orchestrations", root);
  mkdirSync(sessionDir, { recursive: true });

  // MCP 配置：把编排工具挂到这个会话上。--mcp-config 实测是【合并】语义，
  // 用户自己的 MCP server 不会被顶掉。
  const mcpPath = join(sessionDir, "mcp.json");
  writeFileSync(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          herdgent: {
            command: process.execPath,
            args: [
              join(import.meta.dirname, "mcp-server.mjs"),
              "--root", root,
              "--state-dir", registry.stateDir(),
              "--repo", repo,
              "--max-workers", String(maxWorkers),
            ],
          },
        },
      },
      null,
      2,
    ),
  );

  const settingsPath = join(sessionDir, "settings.json");
  const hookPath = join(import.meta.dirname, "hook-claude.mjs");
  const pendingKey = `pending:${root}`;
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${process.execPath} ${hookPath} ${pendingKey} --state-dir ${registry.stateDir()}`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );

  // 登记先于起 agent：SessionStart 钩子在 agent start 执行期间就回调。
  registry.put({
    key: pendingKey,
    slug: root,
    role: "orchestrator",
    root,
    parent: null,
    title: root,
    harness: "claude",
    agent_name: label,
    workspace_label: label,
    workspace_id: workspaceId,
    pane_id: paneId,
    repo,
    cwd: repo,
    status: "starting",
    created_at: new Date().toISOString(),
    settings_path: settingsPath,
    mcp_config_path: mcpPath,
  });
  registry.putOrchestration(root, { max_workers: maxWorkers, repo, started_at: new Date().toISOString() });

  const skillPath = join(import.meta.dirname, "..", "skills", "orchestrate", "SKILL.md");
  const orphanNote = orphans.length
    ? ` Note: ${orphans.length} worker(s) from an earlier orchestration are still marked live and have no orchestrator — ` +
      `they are listed in the herdgent registry as ${orphans.map((o) => o.slug).join(", ")}. ` +
      `Mention this to the human and ask what to do; do not touch them unless told.`
    : "";

  // ⚠️ argv 顺序：--mcp-config 是可变参数，会把紧随其后的位置参数当成第二个配置文件。
  // 初始 prompt 必须排在所有 flag 之后，且中间隔着别的 flag。
  const prompt =
    `You are the orchestrator for a herdgent run (id ${root}, repo ${repo}). ` +
    `Read ${skillPath} now and follow it for the rest of this session. ` +
    `You delegate work through the herdgent MCP tools; you do not write code yourself. ` +
    `Your current worker limit is ${maxWorkers} — use set_worker_limit if the human asks for a different number.${orphanNote} ` +
    `Then greet the human in one line and wait for the task.`;

  const started = startAgentWhenReady([
    "agent", "start", label,
    "--kind", "claude",
    "--pane", paneId,
    "--", "--mcp-config", mcpPath, "--settings", settingsPath, prompt,
  ]);

  const entry = registry.update((reg) => {
    const prev = Object.values(reg.sessions).find((s) => s.slug === root);
    const key = prev?.key ?? pendingKey;
    reg.sessions[key] = {
      ...(prev ?? {}),
      key,
      status: "active",
      dispatch_seq: started.agent?.state_change_seq ?? null,
      harness_session_id: prev?.harness_session_id ?? started.agent?.agent_session?.value ?? null,
    };
    return reg.sessions[key];
  });

  console.log(
    JSON.stringify(
      {
        orchestration: root,
        workspace_id: workspaceId,
        pane_id: paneId,
        repo,
        max_workers: maxWorkers,
        orphans: orphans.map((o) => ({ worker_id: o.slug, title: o.title, root: o.root })),
        orchestrator: entry,
      },
      null,
      2,
    ),
  );
} catch (e) {
  const note = reclaimSession({ workspace_id: workspaceId });
  registry.update((reg) => {
    const row = Object.values(reg.sessions).find((s) => s.slug === root);
    if (row) {
      row.status = "failed";
      row.failure = `${e.code || "?"}: ${e.message}`;
    }
  });
  console.error(`herdgent: orchestrate failed (${e.code || "?"}: ${e.message}); ${note.join(" ")}`);
  throw e;
}
