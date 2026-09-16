// finalize_run 的执行体：显式验收，然后安全地收尾一个 run。
//
// 安全契约（每一条都是踩出来或 audit 出来的，见 Infra/docs/orchestration-lifecycle-audit-20260916.md）：
//
//   · 只清【这个 run 明确登记拥有】的对象——workspace / tab / pane / 分支全部来自
//     run 记录与 worker 登记行，绝不按 label 去全局搜。别的 run、人手建的 tab/workspace
//     不在射程内；fox 的宿主 workspace 永远不动。
//   · 验收是【显式动作】：evidence 由编排者从外部传入并原样落盘。这里不解析任何
//     worker 的输出——「模型说过 PASS」不能成为删除的触发器。
//   · rex 必须【用 git 核验】已合并且干净：merge-base --is-ancestor 验证并入指定 base，
//     checkout 脏（含未跟踪、未合并路径）一律拒绝。信 git，不信转述。
//   · 先落盘结果日志，再停 agent、再清容器/分支。任何一步失败都留下记录，幂等可重试。
//   · 分支只用 `git branch -d`——未合并的分支 git 自己会拒；-D 会把判据和删除揉成一步。
//   · 后来发现非本 run 的 pane/tab 混进了容器 → 拒删，留给人。宁可不收，不可错收。
//   · 附带的基础 workspace（issue #13）：worktree create 隐式建的空壳现在一律改为
//     显式 source 并登记归属证据。finalize 只关【登记为本次创建】且仍未被使用/改动的；
//     领养的（别的 run 或人先建的 primary）与旧 run（无登记）一律不碰——
//     并发复用时 herdr 的 group 守卫（workspace_group_close_required）还会再拦一道。
//
// 【不声称原子】。归属扫描与随后的删除是 TOCTOU 的：扫完到 worktree remove / tab close
// 之间有一个窗口，此刻混进来的 pane/tab 不在防御范围内。这是 best-effort 护栏，
// 叠在「只删台账登记对象」的结构边界之上——两道加一起是【尽力不误删】，不是事务。
// 窗口很小（毫秒级）且触发它需要人在那几毫秒里恰好往这个容器里加东西；真要绝对保证，
// 只能人自己收。同理 auto 的语义只是【显式 finalize 之后默认收】，不是无人值守的定时清理——
// 删除永远从一次显式验收调用开始。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryHerdr } from "./herdr.mjs";
import * as registry from "./registry.mjs";
import { closeBaseWorkspaceIfUnused } from "./worker.mjs";

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

// spawnSync 不抛异常：git 的退出码本身就是要检查的答案。
function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.error) return { status: -1, stdout: "", stderr: String(r.error.message) };
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// 验收的硬前提（仅 worktree 容器的 run）：分支已并入 base 且 checkout 干净。
// 全部用 git 现查，任何一条不过都拒绝——失败 / 未合并的 run 永不进清理。
export function verifyMergeReady({ repo, branch, baseRef, checkoutPath }) {
  if (!repo || !existsSync(repo)) {
    fail("repo_missing", `run's repo ${repo ?? "(unset)"} does not exist on disk — cannot verify the merge`);
  }
  if (git(repo, ["rev-parse", "--git-dir"]).status !== 0) {
    fail("repo_not_git", `${repo} is not a git repository — cannot verify the merge`);
  }
  if (!branch) {
    fail("branch_missing", "this run has no branch on record — nothing to verify, clean up manually if you are sure");
  }
  const base = baseRef || "main";
  if (git(repo, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status !== 0) {
    fail("base_ref_missing", `base ref '${base}' does not exist in ${repo} — cannot verify the merge`);
  }
  if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).status !== 0) {
    fail(
      "branch_missing",
      `branch '${branch}' is already gone from ${repo} — merge can no longer be verified; inspect and clean up manually`,
    );
  }
  const anc = git(repo, ["merge-base", "--is-ancestor", branch, base]);
  if (anc.status !== 0) {
    fail(
      "not_merged",
      `branch '${branch}' is NOT merged into '${base}' (git merge-base --is-ancestor says no). ` +
        "Merge it first — an unmerged branch is the only copy of the work and is never auto-cleaned.",
    );
  }
  // 脏检查在 checkout 里做（含未跟踪文件与未合并路径，porcelain 都会显示）。
  // checkout 已经不在盘上（比如已被手工收掉）则无可脏，跳过。
  if (checkoutPath && existsSync(checkoutPath)) {
    const dirty = git(checkoutPath, ["status", "--porcelain"]);
    if (dirty.status !== 0) {
      fail("checkout_unreadable", `git status failed in checkout ${checkoutPath}: ${dirty.stderr.split("\n")[0]}`);
    }
    if (dirty.stdout) {
      const sample = dirty.stdout.split("\n").slice(0, 5).join("; ");
      fail(
        "worktree_dirty",
        `checkout ${checkoutPath} is dirty (${sample}) — commit or discard first; a dirty scene is never auto-cleaned`,
      );
    }
  }
  return { repo, branch, base, verified: true };
}

// 结果日志：验收结论与每一次清理尝试都落盘，且【先于】任何破坏性动作。
// 一个 run 一份，重试时整份重写（内容含全部 attempts，不丢历史）。
function writeRunLog(logRoot, run, attempts) {
  mkdirSync(logRoot, { recursive: true });
  const body = {
    run_id: run.run_id,
    root: run.root,
    label: run.label ?? null,
    mode: run.mode ?? null,
    container: run.container ?? null,
    workspace_id: run.workspace_id ?? null,
    checkout_path: run.checkout_path ?? null,
    branch: run.branch ?? null,
    base_ref: run.base_ref ?? null,
    repo: run.repo ?? null,
    base_workspace: run.base_workspace ?? null,
    status: run.status,
    created_at: run.created_at ?? null,
    completed_at: run.completed_at ?? null,
    verdict: run.verdict ?? null,
    evidence: run.evidence ?? null,
    merge_verified: run.merge_verified ?? null,
    accepted_at: run.accepted_at ?? null,
    results: run.results ?? [],
    stages: run.stages ?? {},
    cleanup: { ...(run.cleanup ?? {}), attempts },
  };
  const path = join(logRoot, `${run.run_id}.json`);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

function readAttempts(logRoot, runId) {
  try {
    const prev = JSON.parse(readFileSync(join(logRoot, `${runId}.json`), "utf8"));
    return Array.isArray(prev?.cleanup?.attempts) ? prev.cleanup.attempts : [];
  } catch {
    return [];
  }
}

// herdr 整体不可达与「这个对象没了」是两回事：前者中止清理（可重试），
// 后者在重试时是【已经完成】，算 done 不算失败。
const HERDR_DOWN = new Set(["server_not_running", "spawn_failed"]);

function stopRunAgents(run) {
  // 只动登记在这个 run 名下、且仍占位的 worker。ctrl+c 是打断当前轮——
  // 真正的进程清理由随后的容器删除完成；这里先把「还在烧额度的可能」停掉，
  // 再把它们从并发闸里除名（terminated = 不再归编排管，pane 本身不碰）。
  const stopped = [];
  const rows = registry
    .liveWorkerRows(run.root)
    .filter((w) => w.run_id === run.run_id);
  for (const w of rows) {
    if (w.pane_id) tryHerdr(["agent", "send-keys", w.pane_id, "ctrl+c"]);
    stopped.push(w.slug);
  }
  if (stopped.length) {
    registry.update((reg) => {
      for (const row of Object.values(reg.sessions)) {
        if (row.run_id !== run.run_id || row.root !== run.root) continue;
        if (row.status === "starting" || row.status === "active") {
          row.status = "terminated";
          row.terminated_at = new Date().toISOString();
          row.finalized = true;
        }
      }
    });
  }
  return stopped;
}

// worktree 容器的清理：删整个 workspace（连带 checkout），再删分支。
// 删之前先扫一遍——workspace 里混进了任何不属于本 run 的 tab/pane 就整体拒删。
function cleanupWorktreeRun(run, steps) {
  const wsId = run.workspace_id;
  const ownedTabs = new Set(Object.keys(run.stages ?? {}));
  const ownedPanes = new Set(
    registry
      .list()
      .filter((w) => w.run_id === run.run_id && w.root === run.root && w.pane_id)
      .map((w) => w.pane_id),
  );
  for (const p of run.stray_panes ?? []) ownedPanes.add(p.pane_id ?? p);

  const ws = tryHerdr(["workspace", "get", wsId]);
  if (!ws.ok && HERDR_DOWN.has(ws.code)) {
    steps.push({ action: "remove_worktree", target: wsId, status: "aborted", detail: `${ws.code}: ${ws.message}` });
    return "aborted";
  }
  if (!ws.ok && ws.code !== "workspace_not_found") {
    // 读不出来 ≠ 没了。把它当成「已经收掉」会跳过归属扫描直接删分支——拒。
    steps.push({ action: "remove_worktree", target: wsId, status: "failed", detail: `cannot inspect workspace: ${ws.code}: ${ws.message}` });
    return "partial";
  }
  if (!ws.ok) {
    // workspace_not_found：重试场景下这就是【上一步已经成功】。
    steps.push({ action: "remove_worktree", target: wsId, status: "done", detail: "already gone" });
  } else {
    const tabs = tryHerdr(["tab", "list", "--workspace", wsId]);
    const panes = tryHerdr(["pane", "list", "--workspace", wsId]);
    if (!tabs.ok || !panes.ok) {
      const bad = !tabs.ok ? tabs : panes;
      if (HERDR_DOWN.has(bad.code)) {
        steps.push({ action: "scan_workspace", target: wsId, status: "aborted", detail: `${bad.code}: ${bad.message}` });
        return "aborted";
      }
      steps.push({ action: "scan_workspace", target: wsId, status: "failed", detail: `${bad.code}: ${bad.message}` });
      return "partial";
    }
    const foreignTabs = (tabs.result.tabs ?? []).filter((t) => !ownedTabs.has(t.tab_id));
    const foreignPanes = (panes.result.panes ?? []).filter((p) => !ownedPanes.has(p.pane_id));
    if (foreignTabs.length || foreignPanes.length) {
      steps.push({
        action: "scan_workspace",
        target: wsId,
        status: "refused",
        detail:
          `foreign objects in the run's workspace — tabs: ${foreignTabs.map((t) => t.tab_id).join(",") || "none"}, ` +
          `panes: ${foreignPanes.map((p) => p.pane_id).join(",") || "none"}. ` +
          "Someone added to this workspace after the run; refusing to delete it. Close those by hand and retry.",
      });
      return "refused_foreign";
    }
    const rm = tryHerdr(["worktree", "remove", "--workspace", wsId, "--force"]);
    if (rm.ok) {
      steps.push({ action: "remove_worktree", target: wsId, status: "done" });
    } else if (rm.code === "workspace_not_found") {
      steps.push({ action: "remove_worktree", target: wsId, status: "done", detail: "already gone" });
    } else if (HERDR_DOWN.has(rm.code)) {
      steps.push({ action: "remove_worktree", target: wsId, status: "aborted", detail: `${rm.code}: ${rm.message}` });
      return "aborted";
    } else {
      steps.push({ action: "remove_worktree", target: wsId, status: "failed", detail: `${rm.code}: ${rm.message}` });
      return "partial";
    }
  }

  // 分支最后收，且只用 -d：worktree 已拆、合并已核验，-d 应该过；
  // 过不了就是状态在我们核验之后又变了，如实记失败，重试或人来。
  if (run.branch && run.repo) {
    const del = git(run.repo, ["branch", "-d", run.branch]);
    if (del.status === 0) {
      steps.push({ action: "delete_branch", target: run.branch, status: "done" });
    } else if (/not found|no such branch/i.test(del.stderr)) {
      steps.push({ action: "delete_branch", target: run.branch, status: "done", detail: "already gone" });
    } else {
      steps.push({ action: "delete_branch", target: run.branch, status: "failed", detail: del.stderr.split("\n")[0] });
      return "partial";
    }
  }

  // 附带的基础 workspace（issue #13）：只关【登记为本次创建】且仍未被使用的。
  // kept（人动过 / 并发 run 的容器还挂着）是刻意的安全结果，不算失败；
  // failed 进 partial 可重试；aborted 是 herdr 整体不可达。
  if (closeRunBaseWorkspace(run, steps) === "aborted") return "aborted";

  return steps.some((s) => s.status === "failed" || s.status === "refused") ? "partial" : "done";
}

// 基础 workspace 那一步。skipped（无登记 / 领养）与 kept 都不影响收尾结论；
// 只有 failed 让结局变 partial、aborted 直接中止。返回 aborted 或 null。
function closeRunBaseWorkspace(run, steps) {
  const base = run.base_workspace;
  if (!base?.workspace_id) {
    // 跟踪上线前的旧 run 没有任何归属证据——宁可漏收，绝不按猜的收。
    steps.push({
      action: "close_base_workspace",
      target: null,
      status: "skipped",
      detail: "no base workspace on record for this run — nothing provably ours to close",
    });
    return null;
  }
  if (base.created_by_run !== true) {
    steps.push({
      action: "close_base_workspace",
      target: base.workspace_id,
      status: "skipped",
      detail: "pre-existing primary adopted as source (created before this run) — never closed by us",
    });
    return null;
  }
  const back = closeBaseWorkspaceIfUnused({
    workspaceId: base.workspace_id,
    label: base.label ?? null,
    expectedCwd: base.expected_cwd ?? null,
  });
  const status =
    back.status === "closed" || back.status === "already_gone" ? "done" : back.status;
  steps.push({ action: "close_base_workspace", target: base.workspace_id, status, detail: back.detail });
  return back.status === "aborted" ? "aborted" : null;
}

// tab 容器（fox）的清理：只关【本 run 的 tab】，宿主 workspace 一个指头都不碰。
function cleanupTabRun(run, steps) {
  const wsId = run.workspace_id;
  const ownedPanesByTab = new Map();
  for (const w of registry.list().filter((x) => x.run_id === run.run_id && x.root === run.root && x.pane_id)) {
    const arr = ownedPanesByTab.get(w.tab_id) ?? [];
    arr.push(w.pane_id);
    ownedPanesByTab.set(w.tab_id, arr);
  }
  for (const p of run.stray_panes ?? []) {
    const paneId = p.pane_id ?? p;
    const tabId = p.tab_id ?? null;
    const arr = ownedPanesByTab.get(tabId) ?? [];
    arr.push(paneId);
    ownedPanesByTab.set(tabId, arr);
  }

  const panes = tryHerdr(["pane", "list", "--workspace", wsId]);
  if (!panes.ok && HERDR_DOWN.has(panes.code)) {
    steps.push({ action: "scan_tabs", target: wsId, status: "aborted", detail: `${panes.code}: ${panes.message}` });
    return "aborted";
  }
  // workspace_not_found：宿主整个没了，tab 自然也没了，按 already-gone 走下去。
  // 其它读失败【不能】跳过扫描——没有扫描就关 tab 等于闭着眼删。
  if (!panes.ok && panes.code !== "workspace_not_found") {
    steps.push({ action: "scan_tabs", target: wsId, status: "failed", detail: `cannot inspect panes: ${panes.code}: ${panes.message}` });
    return "partial";
  }
  const panesByTab = new Map();
  if (panes.ok) {
    for (const p of panes.result.panes ?? []) {
      const arr = panesByTab.get(p.tab_id) ?? [];
      arr.push(p.pane_id);
      panesByTab.set(p.tab_id, arr);
    }
  }

  for (const [tabId, stage] of Object.entries(run.stages ?? {})) {
    const owned = new Set(ownedPanesByTab.get(tabId) ?? []);
    const foreign = (panesByTab.get(tabId) ?? []).filter((id) => !owned.has(id));
    if (foreign.length) {
      steps.push({
        action: "close_tab",
        target: tabId,
        status: "refused",
        detail: `tab '${stage?.label ?? tabId}' has panes not owned by this run (${foreign.join(",")}) — refusing to close it`,
      });
      continue;
    }
    const r = tryHerdr(["tab", "close", tabId]);
    if (r.ok) {
      steps.push({ action: "close_tab", target: tabId, status: "done" });
    } else if (r.code === "tab_not_found" || r.code === "workspace_not_found") {
      steps.push({ action: "close_tab", target: tabId, status: "done", detail: "already gone" });
    } else if (HERDR_DOWN.has(r.code)) {
      steps.push({ action: "close_tab", target: tabId, status: "aborted", detail: `${r.code}: ${r.message}` });
      return "aborted";
    } else {
      steps.push({ action: "close_tab", target: tabId, status: "failed", detail: `${r.code}: ${r.message}` });
    }
  }
  return steps.some((s) => s.status === "failed" || s.status === "refused") ? "partial" : "done";
}

/**
 * 验收并收尾一个 run。幂等：重复调用会跳过已完成的步骤、重试失败的步骤。
 *
 * @param root        编排 id（归属边界：run 必须挂在这个 root 下）
 * @param runId       run_plan / run_preset 返回的 run id
 * @param verdict     目前只接受 "accept"——失败 / 返工的 run 不需要 finalize，留着就是
 * @param evidence    { review, acceptance }：跨厂评审结论与主验收核对，外部传入，原样落盘
 * @param cleanupMode "auto" | "keep"（调用方已按配置解析好默认值）
 * @param logRoot     结果日志目录（state/runs）
 */
export function finalizeRun({ root, runId, verdict, evidence, cleanupMode, logRoot }) {
  const run = registry.getRun(root, runId);
  if (!run) {
    fail("run_not_found", `no run '${runId}' in this orchestration — check list_runs for the id`);
  }
  if (verdict !== "accept") {
    fail("bad_verdict", `finalize_run only accepts verdict='accept' (got '${verdict}') — a failed run is simply left in place`);
  }

  const alreadyAccepted = run.status === "accepted";
  const previousCleanup = run.cleanup ?? null;

  if (!alreadyAccepted) {
    // 首次验收：证据必须显式给出。这不是形式主义——「evidence 由外部传入」正是
    // 「不能因为模型说了 PASS 就自动删」的结构化落法。
    // 严格 typeof string：String(...) 强转会放 number / String 对象 / 数组混进来，
    // 落盘的必须是编排者写的那段文字本身。
    const review = evidence?.review;
    const acceptance = evidence?.acceptance;
    if (
      typeof review !== "string" ||
      typeof acceptance !== "string" ||
      !review.trim() ||
      !acceptance.trim()
    ) {
      fail(
        "evidence_required",
        "finalize_run needs evidence: { review: '<跨厂评审结论>', acceptance: '<主验收核对>' } — both must be non-empty strings. " +
          "It records WHY acceptance happened; worker output is never parsed for a PASS.",
      );
    }
    // rex 用 git 现查，不信转述。未合并 / 脏 → 拒绝，现场原样保留。
    let merge = null;
    if (run.container === "worktree") {
      merge = verifyMergeReady({
        repo: run.repo,
        branch: run.branch,
        baseRef: run.base_ref,
        checkoutPath: run.checkout_path,
      });
    }
    // 先落盘结果日志，再改状态、再停 agent、再清容器——顺序不能反。
    const acceptedAt = new Date().toISOString();
    const updated = registry.putRun(root, runId, {
      status: "accepted",
      verdict: "accept",
      evidence: { review: review.trim(), acceptance: acceptance.trim() },
      merge_verified: merge,
      accepted_at: acceptedAt,
    });
    writeRunLog(logRoot, updated, readAttempts(logRoot, runId));
    Object.assign(run, updated);
  }

  const mode = cleanupMode === "keep" || cleanupMode === "auto" ? cleanupMode : "auto";

  // keep → auto 的翻案允许（人看完了说「收吧」），但要重新过一遍核验：
  // 现场留了多久不知道，状态得现查。auto → keep 也允许，只要还没清完。
  if (alreadyAccepted && previousCleanup?.mode && previousCleanup.mode !== mode) {
    if (previousCleanup.status === "done" && previousCleanup.mode === "auto") {
      // 已经清完了，没什么可翻的。
      return finalizeView(run, previousCleanup, readAttempts(logRoot, runId), "already finalized and cleaned");
    }
    if (mode === "auto" && run.container === "worktree") {
      verifyMergeReady({
        repo: run.repo,
        branch: run.branch,
        baseRef: run.base_ref,
        checkoutPath: run.checkout_path,
      });
    }
  }

  if (mode === "keep") {
    // keep 也标 accepted：完成状态与保留现场是两回事。agent 从并发闸除名，
    // 但不打断、不关 pane——现场就是留给人的。
    const stopped = stopRunAgentsKeep(run);
    const cleanup = {
      mode: "keep",
      status: "kept",
      steps: [
        {
          action: "keep_scene",
          target: run.workspace_id,
          status: "done",
          detail:
            `scene kept on request; ${stopped} worker(s) dropped from the orchestration gate but left running. ` +
            (run.container === "worktree"
              ? `Manual cleanup: herdr worktree remove --workspace ${run.workspace_id} --force && git -C ${run.repo} branch -d ${run.branch}`
              : "Manual cleanup: close the run's tabs listed in stages."),
        },
      ],
      updated_at: new Date().toISOString(),
    };
    const updated = registry.putRun(root, runId, { cleanup });
    writeRunLog(logRoot, updated, readAttempts(logRoot, runId));
    return finalizeView(updated, cleanup, readAttempts(logRoot, runId));
  }

  // ---- auto：停 agent → 扫归属 → 清容器/分支。每步记录，部分失败可重试。 ----
  // 每一次尝试（含重试）都【先把 in_progress 落盘再动手】：进程死在清理半路时，
  // 日志里必须看得见「这次尝试开始过」，而不是只留下上一次尝试的终态。
  const priorAttempts = readAttempts(logRoot, runId);
  const attempt = { at: new Date().toISOString(), status: "in_progress", steps: [] };
  writeRunLog(logRoot, registry.getRun(root, runId) ?? run, [...priorAttempts, attempt]);

  const stoppedAgents = stopRunAgents(run);
  const steps = [
    {
      action: "stop_agents",
      target: run.run_id,
      status: "done",
      detail: stoppedAgents.length ? `interrupted and released: ${stoppedAgents.join(",")}` : "no live workers left",
    },
  ];
  const outcome =
    run.container === "worktree" ? cleanupWorktreeRun(run, steps) : cleanupTabRun(run, steps);

  const cleanup = { mode: "auto", status: outcome, steps, updated_at: new Date().toISOString() };
  const updated = registry.putRun(root, runId, { cleanup });
  attempt.status = outcome;
  attempt.steps = steps;
  const attempts = [...priorAttempts, attempt];
  writeRunLog(logRoot, updated, attempts);
  return finalizeView(updated, cleanup, attempts);
}

// keep 路径的 worker 除名：不打断（现场要原样留着），只是不再占并发闸。
function stopRunAgentsKeep(run) {
  let n = 0;
  registry.update((reg) => {
    for (const row of Object.values(reg.sessions)) {
      if (row.run_id !== run.run_id || row.root !== run.root) continue;
      if (row.status === "starting" || row.status === "active") {
        row.status = "terminated";
        row.terminated_at = new Date().toISOString();
        row.finalized = true;
        n += 1;
      }
    }
  });
  return n;
}

function finalizeView(run, cleanup, attempts, note = null) {
  const leftover = (cleanup?.steps ?? []).filter((s) => s.status === "failed" || s.status === "refused");
  const kept = (cleanup?.steps ?? []).filter((s) => s.status === "kept");
  return {
    run_id: run.run_id,
    status: run.status,
    accepted_at: run.accepted_at ?? null,
    cleanup_mode: cleanup?.mode ?? null,
    cleanup_status: cleanup?.status ?? null,
    steps: cleanup?.steps ?? [],
    attempts: attempts.length,
    ...(leftover.length
      ? {
          leftover:
            "some steps did not complete — finalize_run is idempotent: fix the cause and call it again with the same run_id",
        }
      : {}),
    // kept 不是失败，但调用者必须【看得见】有东西留着、以及什么时候该回来重试——
    // 否则 done 就静默吞掉了一个还在侧栏的空壳（issue #13 评审）。
    ...(kept.length
      ? {
          kept_notice:
            `kept, not a failure: ${kept.map((s) => `${s.action} ${s.target ?? ""}`.trim()).join("; ")} — ` +
            "the scene is still in use (another run's containers are grouped on it, or someone modified it). " +
            "When the cause is gone (the other run finalized, or the change reverted), call finalize_run again " +
            "with the same run_id: cleanup re-runs idempotently and only the kept objects remain to be closed.",
        }
      : {}),
    ...(note ? { note } : {}),
  };
}
