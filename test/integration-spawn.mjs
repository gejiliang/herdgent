#!/usr/bin/env node
// worktree worker 的时序与失败率验收。【需要真的 herdr server 和真的 harness】，
// 所以不进 npm test；按 AGENTS.md 的隔离配方在命名会话里手动跑：
//
//   HERDR_SOCKET_PATH=~/.config/herdr/sessions/herdgentdev/herdr.sock \
//   HERDGENT_STATE_DIR=/tmp/hg-dev-state \
//   node test/integration-spawn.mjs
//
// 会真的起 N 个 harness 会话（消耗订阅额度），跑完自动回收 workspace / worktree / 分支。
import { execFileSync } from "node:child_process";
import { startManagedSession, reclaimSession, findWorker } from "../lib/worker.mjs";
import * as registry from "../lib/registry.mjs";

const REPO = process.env.HG_REPO || process.cwd();
const N = Number(process.env.HG_N || 6);
const ROOT = "spawn-probe";

if (!process.env.HERDR_SOCKET_PATH) {
  console.error("refusing to run without HERDR_SOCKET_PATH — this must not touch the default session");
  process.exit(2);
}

const spawned = [];
const results = [];

console.log(`起 ${N} 个 worktree worker，repo=${REPO}`);
for (let i = 1; i <= N; i += 1) {
  const t0 = Date.now();
  try {
    const entry = startManagedSession({
      cwd: REPO,
      task: `Reply with exactly the token WORKER_OK_${i} and nothing else.`,
      role: "worker",
      root: ROOT,
      title: `probe-task-${i}`,
      purpose: "explore",
      branch: `hg-probe-${i}`,
    });
    spawned.push(entry);
    results.push({ i, ok: true, ms: Date.now() - t0, agent: entry.agent_name, ws: entry.workspace_id });
    console.log(`  [${i}] ok   ${Date.now() - t0}ms  agent=${entry.agent_name} ws=${entry.workspace_id}`);
  } catch (e) {
    results.push({ i, ok: false, ms: Date.now() - t0, code: e.code, msg: e.message });
    console.log(`  [${i}] FAIL ${Date.now() - t0}ms  ${e.code}: ${e.message}`);
  }
}

const ok = results.filter((r) => r.ok);
const times = ok.map((r) => r.ms);
console.log(
  `\n成功 ${ok.length}/${N}` +
    (times.length
      ? `  最快 ${Math.min(...times)}ms  最慢 ${Math.max(...times)}ms  平均 ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}ms`
      : ""),
);

// 并发闸与登记
const counts = registry.countLive(ROOT);
console.log(`registry: live_in_root=${counts.inRoot} live_global=${counts.global}`);
const named = spawned.every((s) => s.agent_name?.startsWith("probe-task-"));
console.log(`agent 名取自任务而非 harness：${named ? "ok" : "FAIL"}`);
const rekeyed = spawned.filter((s) => findWorker(s.slug)?.harness_session_id).length;
console.log(`SessionStart 钩子回填 session id：${rekeyed}/${spawned.length}`);

// ---- 回收 ----
console.log("\n回收中…");
for (const s of spawned) {
  const steps = reclaimSession(s);
  // worktree remove 【不删分支】——不补这一步，每次编排都在用户仓库里留一个分支。
  if (s.worktree_branch) {
    try {
      execFileSync("git", ["branch", "-D", s.worktree_branch], { cwd: REPO, stdio: "pipe" });
      steps.push("branch_deleted");
    } catch (e) {
      steps.push(`branch_delete_failed:${String(e.stderr || e.message).trim().slice(0, 60)}`);
    }
  }
  console.log(`  ${s.slug} ${steps.join(" ")}`);
}

const leftover = execFileSync("git", ["branch", "--list", "hg-probe-*"], { cwd: REPO, encoding: "utf8" }).trim();
console.log(`残留分支：${leftover || "无"}`);
process.exit(ok.length === N && !leftover ? 0 : 1);
