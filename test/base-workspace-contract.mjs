#!/usr/bin/env node
// issue #13 真实 CLI 契约测试：在【命名隔离会话】里跑真 herdr，
// 逐条验证修复所依赖的上游契约，并拿真 create/finalize 路径过四个场景：
//   契约抽验 —— 隐式创建（issue 本身）、source_workspace_id、group 守卫
//   A. rex 正常流 —— 本次创建的 base 被登记，finalize 后连它一起收干净
//   B. 预存在的 base —— 领养不拥有，finalize 后原样保留
//   C. base 被「用户」改动 —— finalize 保留（kept 是安全结果，不是失败）
//   D. 两个 run 共用一个 base —— 创建者 finalize 时 group 守卫拒关，谁也不误删谁
//
// 不需要模型——只建空 shell 容器与临时 git 仓库。会话、workspace、worktree、
// 分支在退出前全部自清。
//
// 运行：node test/base-workspace-contract.mjs
//
// 隔离（AGENTS.md 铁律）：server 用擦干净的环境 + 唯一 HERDR_SESSION 起，
// 本进程所有 herdr 调用只打那个会话的 socket——绝不连 default。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const SESSION = `hg-i13-contract-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), "hg-i13-contract-"));
const socket = join(homedir(), ".config", "herdr", "sessions", SESSION, "herdr.sock");

// 擦干净的环境起隔离 server：不擦会继承当前 pane 的 HERDR_SOCKET_PATH 连回 default。
// HERDGENT_* 也必须处理：server 会把环境传给它在 pane 里起的一切（含 hook），
// 带着环境里的 HERDGENT_STATE_DIR / HERDGENT_HOME 就会写到【真】registry——
// 评审抓到的正是这个：光删不够，还要显式指到临时目录，泄漏路径才没有落点。
const serverEnv = { ...process.env };
for (const k of Object.keys(serverEnv)) {
  if (k.startsWith("HERDR_") || k.startsWith("CLAUDE") || k.startsWith("HERDGENT_")) delete serverEnv[k];
}
serverEnv.HERDR_SESSION = SESSION;
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "config"), { recursive: true });
serverEnv.HERDGENT_HOME = home;
serverEnv.HERDGENT_STATE_DIR = join(home, "state");
serverEnv.HERDGENT_CONFIG_DIR = join(home, "config");
const server = spawn("herdr", ["server"], { env: serverEnv, stdio: "ignore" });

// 回归断言：隔离 server 的环境里，herdgent 的三个落盘变量必须全部指向临时目录，
// 且没有任何 HERDGENT_* 指向真家目录（~/.herdgent）——这条挂了，后面跑什么都别信。
{
  const realHome = join(homedir(), ".herdgent");
  const leaked = Object.entries(serverEnv).filter(([k, v]) => k.startsWith("HERDGENT_") && String(v).startsWith(realHome));
  check(
    "隔离 server 的 HERDGENT_* 全部指向临时目录，无真 registry 落点",
    leaked.length === 0 &&
      serverEnv.HERDGENT_STATE_DIR === join(home, "state") &&
      serverEnv.HERDGENT_CONFIG_DIR === join(home, "config") &&
      serverEnv.HERDGENT_HOME === home,
    leaked.map(([k, v]) => `${k}=${v}`).join(", ") || "clean",
  );
}

// 本测试建过的临时 repo（basename 带 pid，全局唯一）。finalize 正常会收掉
// worktree checkout；若有断言失败中途退出，cleanup 必须把残壳也收走——
// 测试可以失败，不能在 GG 的 worktrees 目录里留东西。
const madeRepos = [];

function cleanup() {
  // session stop/delete 走会话名定位；socket 指向自己，怎么解释都不会碰 default。
  spawnSync("herdr", ["session", "stop", SESSION], { encoding: "utf8", env: { ...serverEnv, HERDR_SOCKET_PATH: socket } });
  spawnSync("herdr", ["session", "delete", SESSION], { encoding: "utf8", env: { ...serverEnv, HERDR_SOCKET_PATH: socket } });
  server.kill();
  // 残壳回收：先经 git 正规拆（repo 还在时元数据干净），再抹 herdr 的父目录。
  for (const repo of madeRepos) {
    const list = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const line of (list.stdout || "").split("\n")) {
      if (!line.startsWith("worktree ") || line.includes(repo)) continue;
      spawnSync("git", ["-C", repo, "worktree", "remove", "--force", line.slice(9)], { encoding: "utf8" });
    }
    spawnSync("git", ["-C", repo, "worktree", "prune"], { encoding: "utf8" });
    rmSync(join(homedir(), ".herdr", "worktrees", basename(repo)), { recursive: true, force: true });
  }
  rmSync(home, { recursive: true, force: true });
}

const upDeadline = Date.now() + 15000;
while (!existsSync(socket) && Date.now() < upDeadline) sleepSync(250);
if (!existsSync(socket)) {
  console.error("isolated herdr server never came up — aborting without touching anything");
  cleanup();
  process.exit(1);
}

// 此后本进程（以及它 spawn 的每一个 herdr CLI）只打隔离 socket。
process.env.HERDR_SOCKET_PATH = socket;
process.env.HERDGENT_HOME = home;
process.env.HERDGENT_STATE_DIR = join(home, "state");
process.env.HERDGENT_CONFIG_DIR = join(home, "config");
delete process.env.HERDR_BIN_PATH; // 用真 herdr
// 双保险：default socket 的路径里不可能出现这个会话名。
if (!process.env.HERDR_SOCKET_PATH.includes(SESSION)) {
  console.error("socket path sanity check failed — refusing to run");
  cleanup();
  process.exit(1);
}

const worker = await import(`../lib/worker.mjs?t=${Date.now()}`);
const finalize = await import(`../lib/finalize.mjs?t=${Date.now()}`);
const registry = await import(`../lib/registry.mjs?t=${Date.now()}`);
const herdrLib = await import(`../lib/herdr.mjs?t=${Date.now()}`);

// 回归断言：本进程的 registry 也必须解析到临时目录——lib 是惰性读 env 的，
// 顺序哪天被改坏（先 import 后设 env），这条会立刻抓住。
check(
  "本进程的 registry 解析在临时目录",
  registry.stateDir().startsWith(home),
  registry.stateDir(),
);

const git = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const herdrJson = (...args) => {
  const r = spawnSync("herdr", args, { encoding: "utf8" });
  const raw = (r.stdout || "").trim() || (r.stderr || "").trim();
  return JSON.parse(raw);
};
const wsIds = () => (herdrJson("workspace", "list").result.workspaces ?? []).map((w) => w.workspace_id);
const branchExists = (dir, name) => git(dir, "branch", "--list", name).stdout.trim() !== "";

function mkRepo(name) {
  const dir = join(home, name);
  mkdirSync(dir);
  git(dir, "init", "-b", "main");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
  const resolved = realpathSync(dir); // 与 run_plan 的 resolveRepo 同形：git 解析过的绝对路径
  madeRepos.push(resolved);
  return resolved;
}

const ROOT = "orc-contract";
let runSeq = 0;
// 与 runPlan 真实登记的形状一致：stages 里有容器自带的 root tab，
// registry 里有占着 root pane 的 worker 行——finalize 的归属扫描靠它们认 owned。
function registerRun(space, repo, branch) {
  const runId = `run-c${++runSeq}`;
  registry.putRun(ROOT, runId, {
    mode: "rex",
    container: "worktree",
    label: runId,
    workspace_id: space.workspaceId,
    checkout_path: space.checkoutPath,
    branch,
    base_ref: "main",
    repo,
    base_workspace: space.baseWorkspace
      ? {
          workspace_id: space.baseWorkspace.workspaceId,
          created_by_run: space.baseWorkspace.createdByUs,
          label: space.baseWorkspace.label,
          expected_cwd: space.baseWorkspace.expectedCwd,
          evidence: space.baseWorkspace.evidence,
        }
      : null,
    stages: space.rootTabId
      ? { [space.rootTabId]: { label: "1 impl", step: "impl", status: "done", root_pane_id: space.rootPaneId } }
      : {},
    status: "completed",
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  });
  registry.put({
    key: `contract:${runId}`,
    slug: `c${runSeq}`,
    role: "worker",
    root: ROOT,
    run_id: runId,
    step_id: "impl",
    harness: "pi",
    workspace_id: space.workspaceId,
    tab_id: space.rootTabId,
    pane_id: space.rootPaneId,
    status: "terminated", // 活已干完：不占并发闸，但 pane 归属在本 run 名下
    created_at: new Date().toISOString(),
  });
  return runId;
}
const EVIDENCE = { review: "contract test review", acceptance: "contract test acceptance" };
const fin = (runId) =>
  finalize.finalizeRun({
    root: ROOT,
    runId,
    verdict: "accept",
    evidence: EVIDENCE,
    cleanupMode: "auto",
    logRoot: join(home, "state", "runs"),
  });
// 关闭判据要看 pane 的 shell 提示符；刚建完容器时 shell 可能还没就绪，先等稳。
function waitBaseShell(baseId) {
  const paneId = herdrJson("pane", "list", "--workspace", baseId).result.panes[0].pane_id;
  herdrLib.waitForShell(paneId);
}

try {
  // ================= 契约抽验：修复依赖的上游行为，逐条对得上才继续 =================
  const repoP = mkRepo(`repoP-${process.pid}`);
  const before = herdrJson("worktree", "list", "--cwd", repoP).result;
  check("契约: 无 primary 时 source_workspace_id 缺失", !("source_workspace_id" in before.source), JSON.stringify(before.source));
  const implicit = herdrJson("worktree", "create", "--cwd", repoP, "--label", "probe", "--no-focus", "--branch", "probe/x").result;
  const after = herdrJson("worktree", "list", "--cwd", repoP).result;
  check(
    "契约: --cwd 隐式多建了 base（issue 本身）并被 source_workspace_id 指认",
    !!after.source.source_workspace_id && after.source.source_workspace_id !== implicit.workspace.workspace_id,
    JSON.stringify(after.source),
  );
  const guarded = herdrJson("workspace", "close", after.source.source_workspace_id);
  check("契约: primary 有 linked 子时 herdr 拒关（group 守卫）", guarded.error?.code === "workspace_group_close_required", JSON.stringify(guarded.error));
  herdrJson("worktree", "remove", "--workspace", implicit.workspace.workspace_id, "--force");
  const closeOk = herdrJson("workspace", "close", after.source.source_workspace_id);
  check("契约: 子没了之后 primary 可关", !closeOk.error, JSON.stringify(closeOk.error ?? closeOk.result));
  git(repoP, "branch", "-d", "probe/x");

  // ================= A. rex 正常流 =================
  const repoA = mkRepo(`repoA-${process.pid}`);
  const spaceA = worker.createOrchestrationSpace({ repo: repoA, label: "rex · 契约A", branch: "feat/a" });
  check("A: base 由本次创建并登记", spaceA.baseWorkspace?.createdByUs === true && !!spaceA.baseWorkspace.workspaceId, JSON.stringify(spaceA.baseWorkspace));
  check("A: 一 base 一 worktree 两个 workspace", wsIds().length === 2, wsIds().join(","));
  waitBaseShell(spaceA.baseWorkspace.workspaceId);
  const runA = registerRun(spaceA, repoA, "feat/a");
  const resA = fin(runA);
  check("A: finalize done", resA.cleanup_status === "done", JSON.stringify(resA.steps));
  check(
    "A: base 关闭步骤 done",
    (resA.steps ?? []).some((s) => s.action === "close_base_workspace" && s.status === "done"),
    JSON.stringify(resA.steps),
  );
  check("A: workspace 全收干净", wsIds().length === 0, wsIds().join(","));
  check("A: 分支已用 -d 删除", !branchExists(repoA, "feat/a"));
  check("A: 台账保留归属证据", (registry.getRun(ROOT, runA).base_workspace?.evidence ?? "").includes("workspace_id="), registry.getRun(ROOT, runA).base_workspace?.evidence);
  const logA = JSON.parse(readFileSync(join(home, "state", "runs", `${runA}.json`), "utf8"));
  check(
    "A: run 日志记了 base 与关闭步骤",
    logA.base_workspace?.workspace_id === spaceA.baseWorkspace.workspaceId &&
      (logA.cleanup?.attempts ?? []).flatMap((a) => a.steps ?? []).some((s) => s.action === "close_base_workspace" && s.status === "done"),
    JSON.stringify(logA.base_workspace),
  );

  // ================= B. 预存在的 base 保留 =================
  const repoB = mkRepo(`repoB-${process.pid}`);
  const preBase = herdrJson("workspace", "create", "--cwd", repoB, "--label", `repoB-${process.pid}`, "--no-focus").result.workspace.workspace_id;
  const spaceB = worker.createOrchestrationSpace({ repo: repoB, label: "rex · 契约B", branch: "feat/b" });
  check(
    "B: 领养预存在 base，不多建",
    spaceB.baseWorkspace?.createdByUs === false && spaceB.baseWorkspace.workspaceId === preBase && wsIds().length === 2,
    `${JSON.stringify(spaceB.baseWorkspace)} ws=${wsIds().join(",")}`,
  );
  const runB = registerRun(spaceB, repoB, "feat/b");
  const resB = fin(runB);
  check(
    "B: finalize done 且 base 步骤 skipped",
    resB.cleanup_status === "done" && (resB.steps ?? []).some((s) => s.action === "close_base_workspace" && s.status === "skipped"),
    JSON.stringify(resB.steps),
  );
  check("B: 预存在 base 原样保留", wsIds().includes(preBase), wsIds().join(","));
  const preClose = herdrJson("workspace", "close", preBase); // 测试卫生：人手工收自己的
  check("B: 手工收尾成功（无子可关）", !preClose.error && wsIds().length === 0, JSON.stringify(preClose.error ?? wsIds()));

  // ================= C. base 被「用户」改动后保留 =================
  const repoC = mkRepo(`repoC-${process.pid}`);
  const spaceC = worker.createOrchestrationSpace({ repo: repoC, label: "rex · 契约C", branch: "feat/c" });
  waitBaseShell(spaceC.baseWorkspace.workspaceId);
  herdrJson("tab", "create", "--workspace", spaceC.baseWorkspace.workspaceId, "--label", "人的 tab", "--no-focus");
  const runC = registerRun(spaceC, repoC, "feat/c");
  const resC = fin(runC);
  check(
    "C: base 被动过 → kept，cleanup 仍 done",
    resC.cleanup_status === "done" && (resC.steps ?? []).some((s) => s.action === "close_base_workspace" && s.status === "kept"),
    JSON.stringify(resC.steps),
  );
  check("C: base 与人的 tab 都在", wsIds().includes(spaceC.baseWorkspace.workspaceId), wsIds().join(","));
  check("C: run 自己的 worktree 与分支照收", !wsIds().includes(spaceC.workspaceId) && !branchExists(repoC, "feat/c"));
  const cClose = herdrJson("workspace", "close", spaceC.baseWorkspace.workspaceId); // 卫生：子已收，守卫放行
  check("C: 卫生关闭成功", !cClose.error && wsIds().length === 0, JSON.stringify(cClose.error ?? wsIds()));

  // ================= D. 两个 run 共用一个 base，谁也不误删谁 =================
  const repoD = mkRepo(`repoD-${process.pid}`);
  const spaceD1 = worker.createOrchestrationSpace({ repo: repoD, label: "rex · 契约D1", branch: "feat/d1" });
  const spaceD2 = worker.createOrchestrationSpace({ repo: repoD, label: "rex · 契约D2", branch: "feat/d2" });
  check(
    "D: 第二个 run 领养第一个的 base",
    spaceD1.baseWorkspace?.createdByUs === true &&
      spaceD2.baseWorkspace?.createdByUs === false &&
      spaceD2.baseWorkspace.workspaceId === spaceD1.baseWorkspace.workspaceId,
    `D1=${JSON.stringify(spaceD1.baseWorkspace)} D2=${JSON.stringify(spaceD2.baseWorkspace)}`,
  );
  waitBaseShell(spaceD1.baseWorkspace.workspaceId);
  const runD1 = registerRun(spaceD1, repoD, "feat/d1");
  const resD1 = fin(runD1);
  check(
    "D: 创建者 finalize → group 守卫拒关 base（kept），其余 done",
    resD1.cleanup_status === "done" &&
      (resD1.steps ?? []).some((s) => s.action === "close_base_workspace" && s.status === "kept" && /linked worktree/.test(s.detail ?? "")),
    JSON.stringify(resD1.steps),
  );
  check(
    "D: base 与 D2 的容器都活着",
    wsIds().includes(spaceD1.baseWorkspace.workspaceId) && wsIds().includes(spaceD2.workspaceId),
    wsIds().join(","),
  );
  const runD2 = registerRun(spaceD2, repoD, "feat/d2");
  const resD2 = fin(runD2);
  check(
    "D: 领养者 finalize → skipped，不动 base",
    resD2.cleanup_status === "done" && (resD2.steps ?? []).some((s) => s.action === "close_base_workspace" && s.status === "skipped"),
    JSON.stringify(resD2.steps),
  );
  check("D: 两个 run 都没删共享 base", wsIds().includes(spaceD1.baseWorkspace.workspaceId), wsIds().join(","));
  const dClose = herdrJson("workspace", "close", spaceD1.baseWorkspace.workspaceId); // 卫生
  check("D: 全部收干净", !dClose.error && wsIds().length === 0, JSON.stringify(dClose.error ?? wsIds()));
  check("D: 两条分支都删了", !branchExists(repoD, "feat/d1") && !branchExists(repoD, "feat/d2"));

  // ================= 回归：真 registry 一个字节都没被碰 =================
  // 本测试的工件都有不可冲撞的前缀（contract: / run-c / orc-contract）；
  // 隔离只要破了一条缝，它们就会出现在 ~/.herdgent/state/registry.json 里。
  {
    const realRegistry = join(homedir(), ".herdgent", "state", "registry.json");
    let contamination = "none";
    if (existsSync(realRegistry)) {
      const real = JSON.parse(readFileSync(realRegistry, "utf8"));
      const badSessions = Object.keys(real.sessions ?? {}).filter((k) => k.startsWith("contract:"));
      const badRoots = Object.keys(real.orchestrations ?? {}).filter((k) => k === ROOT);
      const badRuns = Object.values(real.orchestrations ?? {}).flatMap((o) =>
        Object.keys(o.runs ?? {}).filter((id) => /^run-c\d+$/.test(id)),
      );
      const bad = [...badSessions, ...badRoots, ...badRuns];
      if (bad.length) contamination = bad.join(",");
    }
    check("真 registry 未被本测试写入（隔离无泄漏）", contamination === "none", contamination);
  }
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
