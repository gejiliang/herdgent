#!/usr/bin/env node
// Claude Code SessionStart 钩子：把 harness 侧的 session id 回填进登记表。
// 这是控制面的第一块 —— 它让登记表拥有一个不随 herdr 重启而变的主键。
//
// 用法：node hook-claude.mjs <pending-key> --state-dir <dir>
// state-dir 必须显式传：plugin 的 HERDR_PLUGIN_STATE_DIR 不会传进它启动的会话。
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const pendingKey = argv[0];
const dirFlag = argv.indexOf("--state-dir");
if (dirFlag !== -1 && argv[dirFlag + 1]) process.env.HERDGENT_STATE_DIR = argv[dirFlag + 1];

const registry = await import("../lib/registry.mjs");

let payload = {};
let parseError = null;
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch (e) {
  parseError = e.message; // 钩子绝不能让 harness 启动失败：记下来，继续。
}

const sessionId = payload.session_id || null;

// 整段在锁内：起会话的 action 进程此刻正在写同一张表（钩子在 agent start 执行期间就回调）。
// 任何异常都只能留痕，绝不能抛——这个进程跑在 harness 的启动路径上。
try {
  const outcome = registry.update((reg) => {
    const prev = reg.sessions[pendingKey];
    if (!prev) return { rekeyed: false };

    const key = sessionId ? `claude:${sessionId}` : pendingKey;
    delete reg.sessions[pendingKey];
    reg.sessions[key] = {
      ...prev,
      key,
      harness_session_id: sessionId,
      transcript_path: payload.transcript_path || null,
      hook_seen_at: new Date().toISOString(),
    };
    return { rekeyed: true, key };
  });

  if (outcome.rekeyed) {
    registry.auditLog(`rekey ${pendingKey} -> ${outcome.key} parse_error=${parseError ?? "none"}`);
  } else {
    registry.auditLog(
      `miss key=${pendingKey} session_id=${sessionId ?? "none"} parse_error=${parseError ?? "none"}`,
    );
  }
} catch (e) {
  registry.auditLog(`hook failed key=${pendingKey} err=${e.code || "?"}: ${e.message}`);
}
