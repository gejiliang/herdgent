#!/usr/bin/env node
// finalize_run 验收：显式验收、git 核验、归属扫描、幂等重试、跨 run 分离。
//
// 安全路径是这里的被测主体，一个都不能少：
//   未合并拒删 / 脏拒删 / 外来 tab/pane 拒删 / fox 不碰宿主 workspace /
//   keep 也标 accepted / 分支只用 -d / 先落盘再动手 / 部分失败可重试。
// herdr 是假 CLI + 假事件 socket（test/fake-herdr.mjs）；git 用本地临时真仓库。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setupFakeHerdr, startEventSocket, closeSocket, writePiTranscript, mcpProbe } from "./fake-herdr.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-finalize-"));
const state = join(home, "state");
const config = join(home, "config");
mkdirSync(state, { recursive: true });
mkdirSync(config, { recursive: true });
const fake = setupFakeHerdr(home);
const socket = join(home, "fake-herdr.sock");
const transcript = join(home, "transcript.jsonl");
writePiTranscript(transcript, ["impl done"]);

const repo = join(home, "repo");
mkdirSync(repo);
const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const branchExists = (name) => git("branch", "--list", name).stdout.trim() !== "";
const branchExistsIn = (dir, name) => spawnSync("git", ["-C", dir, "branch", "--list", name], { encoding: "utf8" }).stdout.trim() !== "";
git("init", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", ".");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init");
for (const b of ["feat/ok1", "feat/ok2", "feat/keep", "feat/foreign"]) git("branch", b);
// 未合并分支：上面有一个 main 没有的 commit
git("checkout", "-b", "feat/unmerged");
writeFileSync(join(repo, "b.txt"), "b\n");
git("add", ".");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "unmerged work");
git("checkout", "main");

// 基础 workspace（issue #13）的三个专属场景各用一个独立 repo：
//   repo2 —— run 独占自己创建的 base，finalize 后 base 必须真关掉；
//   repo3 —— 预存在的 base（人 / 旧 run 留下的），领养不拥有，绝不删；
//   repo4 —— run 创建的 base 随后被「用户」改动，保留。
const mkRepo = (name, branch) => {
  const dir = join(home, name);
  mkdirSync(dir);
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  g("add", ".");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init");
  g("branch", branch);
  return dir;
};
const repo2 = mkRepo("repo2", "feat/solo");
const repo3 = mkRepo("repo3", "feat/pre");
const repo4 = mkRepo("repo4", "feat/mod");

writeFileSync(
  join(config, "profiles.json"),
  JSON.stringify({ profiles: { "test-impl": { harness: "pi", vendor: "test", model: "test/model", yolo: true, description: "test" } } }),
);

const ENV = {
  HERDGENT_HOME: home,
  HERDGENT_STATE_DIR: state,
  HERDGENT_CONFIG_DIR: config,
  HERDR_BIN_PATH: fake.bin,
  HERDR_SOCKET_PATH: socket,
  HG_FAKE_HERDR_STATE: fake.statePath,
  HG_FAKE_TRANSCRIPT: transcript,
  HERDR_PANE_ID: "w0:p0",
};
const ARGS = ["--root", "orc-test"];
const EVIDENCE = { review: "review-kimi PASS：逐条核对验收标准，无缺陷", acceptance: "我亲自核对了 diff 与测试，是要的东西" };

// repo3 的【预存在】基础 workspace：在 run 跑之前就进假 herdr 的台账。
// primaries 的键必须与 run_plan 解析后的 repo 路径一致（git 解析过的绝对路径）。
{
  const s = JSON.parse(readFileSync(fake.statePath, "utf8"));
  const key = realpathSync(repo3);
  s.workspaces.wPre = { workspace_id: "wPre", label: "repo3", cwd: key, kind: "plain", agent_status: "unknown" };
  s.tabs["wPre:t1"] = { tab_id: "wPre:t1", workspace_id: "wPre", label: "1" };
  s.panes["wPre:p1"] = { pane_id: "wPre:p1", tab_id: "wPre:t1", workspace_id: "wPre", foreground_cwd: key, agent_status: "unknown" };
  s.primaries[key] = "wPre";
  writeFileSync(fake.statePath, JSON.stringify(s, null, 2));
}

const registryFile = () => JSON.parse(readFileSync(join(state, "registry.json"), "utf8"));
const fakeState = () => JSON.parse(readFileSync(fake.statePath, "utf8"));
const writeFakeState = (s) => writeFileSync(fake.statePath, JSON.stringify(s, null, 2));
const getRun = (id) => registryFile().orchestrations["orc-test"].runs[id];
const fin = (key, run_id, extra = {}) => ({ key, name: "finalize_run", arguments: { run_id, verdict: "accept", evidence: EVIDENCE, ...extra } });
const rexCall = (key, branch, repoArg = repo) => ({
  key,
  name: "run_plan",
  arguments: { label: key, branch, repo: repoArg, steps: [{ id: "impl", title: "impl", profile: "test-impl", task: `do ${key}` }] },
});

const socketServer = await startEventSocket(socket);
try {
  // ---- 起五个 rex run + 一个 fox run ----
  const setup = await mcpProbe({
    args: ARGS,
    env: ENV,
    calls: [
      rexCall("runA", "feat/ok1"),
      rexCall("runB", "feat/ok2"),
      rexCall("runKeep", "feat/keep"),
      rexCall("runForeign", "feat/foreign"),
      rexCall("runUnmerged", "feat/unmerged"),
      rexCall("runSolo", "feat/solo", repo2),
      rexCall("runPre", "feat/pre", repo3),
      rexCall("runMod", "feat/mod", repo4),
      {
        key: "runFox",
        name: "run_plan",
        arguments: {
          label: "调研",
          mode: "fox",
          steps: [
            { id: "s1", title: "s1", profile: "test-impl", task: "看一" },
            { id: "s2", title: "s2", profile: "test-impl", task: "看二" },
          ],
        },
      },
    ],
  });
  const ids = Object.fromEntries(
    ["runA", "runB", "runKeep", "runForeign", "runUnmerged", "runFox", "runSolo", "runPre", "runMod"].map((k) => [k, setup[k].run_id]),
  );
  check("九个 run 都跑完", Object.values(setup).every((x) => x.completed === true), JSON.stringify(Object.keys(ids)));

  // 共享 repo 的五个 run：runA 建 base，其余领养；独立 repo 的三个各自建各自的（runPre 领养）。
  check("runA 创建共享 base", getRun(ids.runA).base_workspace?.created_by_run === true);
  check("runB 领养共享 base", getRun(ids.runB).base_workspace?.created_by_run === false && getRun(ids.runB).base_workspace?.workspace_id === getRun(ids.runA).base_workspace?.workspace_id);
  check("runSolo 创建独占 base", getRun(ids.runSolo).base_workspace?.created_by_run === true);
  check("runPre 领养预存在的 wPre", getRun(ids.runPre).base_workspace?.created_by_run === false && getRun(ids.runPre).base_workspace?.workspace_id === "wPre", JSON.stringify(getRun(ids.runPre).base_workspace));

  // ---- 拒绝路径：未合并 / 缺证据 / 坏 verdict / 非字符串证据 ----
  const refuse = await mcpProbe({
    args: ARGS,
    env: ENV,
    calls: [
      fin("notMerged", ids.runUnmerged),
      { key: "noEvidence", name: "finalize_run", arguments: { run_id: ids.runA, verdict: "accept" } },
      { key: "badVerdict", name: "finalize_run", arguments: { run_id: ids.runA, verdict: "reject", evidence: EVIDENCE } },
      { key: "noRun", name: "finalize_run", arguments: { run_id: "run-nope", verdict: "accept", evidence: EVIDENCE } },
      // 严格 typeof string：number / 数组 / 对象都不能被 String() 强转放行
      { key: "numEvidence", name: "finalize_run", arguments: { run_id: ids.runA, verdict: "accept", evidence: { review: 42, acceptance: "x" } } },
      { key: "arrEvidence", name: "finalize_run", arguments: { run_id: ids.runA, verdict: "accept", evidence: { review: "x", acceptance: ["y"] } } },
      { key: "blankEvidence", name: "finalize_run", arguments: { run_id: ids.runA, verdict: "accept", evidence: { review: "   ", acceptance: "x" } } },
    ],
  });
  check("未合并拒绝", refuse.notMerged.isError && refuse.notMerged.error === "not_merged", JSON.stringify(refuse.notMerged));
  check("未合并的 run 没有被验收", getRun(ids.runUnmerged).status === "completed", getRun(ids.runUnmerged).status);
  check("未合并的现场原样保留", !!fakeState().workspaces[getRun(ids.runUnmerged).workspace_id] && branchExists("feat/unmerged"));
  check("缺证据拒绝", refuse.noEvidence.isError && refuse.noEvidence.error === "evidence_required", JSON.stringify(refuse.noEvidence));
  check("坏 verdict 拒绝", refuse.badVerdict.isError && refuse.badVerdict.error === "bad_verdict", JSON.stringify(refuse.badVerdict));
  check("finalize 也守归属边界", refuse.noRun.isError && refuse.noRun.error === "run_not_found", JSON.stringify(refuse.noRun));
  check("数字证据拒绝", refuse.numEvidence.isError && refuse.numEvidence.error === "evidence_required", JSON.stringify(refuse.numEvidence));
  check("数组证据拒绝", refuse.arrEvidence.isError && refuse.arrEvidence.error === "evidence_required", JSON.stringify(refuse.arrEvidence));
  check("空白串证据拒绝", refuse.blankEvidence.isError && refuse.blankEvidence.error === "evidence_required", JSON.stringify(refuse.blankEvidence));
  check("被拒后 runA 未验收", getRun(ids.runA).status === "completed", getRun(ids.runA).status);

  // ---- 脏 checkout 拒删；收拾干净后重试成功 ----
  const dirtyCheckout = getRun(ids.runB).checkout_path;
  mkdirSync(dirtyCheckout, { recursive: true });
  spawnSync("git", ["-C", dirtyCheckout, "init", "-b", "main"], { encoding: "utf8" });
  writeFileSync(join(dirtyCheckout, "leftover.log"), "not committed\n");
  const dirty = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runB)] });
  check("脏 checkout 拒绝", dirty.f.isError && dirty.f.error === "worktree_dirty", JSON.stringify(dirty.f));
  check("脏现场原样保留", !!fakeState().workspaces[getRun(ids.runB).workspace_id] && branchExists("feat/ok2"));
  rmSync(join(dirtyCheckout, "leftover.log"));
  const cleaned = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runB)] });
  check("收拾干净后重试成功", cleaned.f.isError !== true && cleaned.f.cleanup_status === "done", JSON.stringify(cleaned.f).slice(0, 120));
  check("runB 分支已安全删除", !branchExists("feat/ok2"));

  // ---- 外来 tab 拒删 workspace；挪走后重试成功 ----
  const foreignLog = join(state, "runs", `${ids.runForeign}.json`);
  {
    const s = fakeState();
    const ws = getRun(ids.runForeign).workspace_id;
    s.tabs["wX:tForeign"] = { tab_id: "wX:tForeign", workspace_id: ws, label: "人手加的" };
    writeFakeState(s);
  }
  const foreign = await mcpProbe({ args: ARGS, env: { ...ENV, HG_FAKE_RUN_LOG: foreignLog }, calls: [fin("f", ids.runForeign)] });
  check("外来 tab 拒删", foreign.f.isError !== true && foreign.f.cleanup_status === "refused_foreign", JSON.stringify(foreign.f).slice(0, 200));
  check("外来 tab 时验收已落盘（完成与现场分离）", getRun(ids.runForeign).status === "accepted", getRun(ids.runForeign).status);
  check("拒删时容器与分支都还在", !!fakeState().workspaces[getRun(ids.runForeign).workspace_id] && branchExists("feat/foreign"));
  {
    const s = fakeState();
    delete s.tabs["wX:tForeign"];
    writeFakeState(s);
  }
  const foreignRetry = await mcpProbe({ args: ARGS, env: { ...ENV, HG_FAKE_RUN_LOG: foreignLog }, calls: [fin("f", ids.runForeign)] });
  check("挪走外来 tab 后重试清干净", foreignRetry.f.cleanup_status === "done", JSON.stringify(foreignRetry.f).slice(0, 120));
  check("重试后容器与分支收掉", !fakeState().workspaces[getRun(ids.runForeign).workspace_id] && !branchExists("feat/foreign"));
  check(
    "重试的破坏性动作前已落 in_progress 日志",
    fakeState().calls.includes("logcheck:in_progress") && !fakeState().calls.includes("logcheck:no_in_progress"),
    fakeState().calls.filter((c) => c.startsWith("logcheck")).join(",") || "no logcheck",
  );
  {
    const attempts = JSON.parse(readFileSync(foreignLog, "utf8")).cleanup.attempts;
    check(
      "两次 attempt 都有终态，无滞留 in_progress",
      attempts.length === 2 && attempts[0].status === "refused_foreign" && attempts[1].status === "done",
      JSON.stringify(attempts.map((a) => a.status)),
    );
  }

  // ---- happy path auto + 幂等 ----
  const happyLog = join(state, "runs", `${ids.runA}.json`);
  const happy = await mcpProbe({ args: ARGS, env: { ...ENV, HG_FAKE_RUN_LOG: happyLog }, calls: [fin("f", ids.runA)] });
  check("auto 收尾成功", happy.f.isError !== true && happy.f.cleanup_status === "done", JSON.stringify(happy.f).slice(0, 200));
  check("runA 标 accepted", getRun(ids.runA).status === "accepted" && !!getRun(ids.runA).accepted_at);
  const stepActions = (happy.f.steps ?? []).map((s) => `${s.action}:${s.status}`);
  check("步骤齐：停 agent→收 worktree→删分支", stepActions.join(",").includes("stop_agents:done") && stepActions.join(",").includes("remove_worktree:done") && stepActions.join(",").includes("delete_branch:done"), stepActions.join(","));
  check("runA worktree 已收", !fakeState().workspaces[getRun(ids.runA).workspace_id]);
  check("runA 分支已用 -d 删除", !branchExists("feat/ok1"));
  const workerA = Object.values(registryFile().sessions).find((s) => s.run_id === ids.runA);
  check("runA 的 worker 从闸里除名", workerA?.status === "terminated" && workerA?.finalized === true, workerA?.status);
  const logPath = join(state, "runs", `${ids.runA}.json`);
  check("结果日志先于清理落盘", existsSync(logPath));
  const logBody = JSON.parse(readFileSync(logPath, "utf8"));
  check("日志里有证据与尝试记录", logBody.evidence?.review === EVIDENCE.review && Array.isArray(logBody.cleanup?.attempts) && logBody.results?.length === 1, JSON.stringify(logBody).slice(0, 120));
  check("日志记了 merge 核验", logBody.merge_verified?.verified === true && logBody.merge_verified?.base === "main");

  check(
    "首次破坏性动作前已落 in_progress 日志",
    fakeState().calls.filter((c) => c === "logcheck:in_progress").length >= 2,
    fakeState().calls.filter((c) => c.startsWith("logcheck")).join(","),
  );

  // ---- 基础 workspace（issue #13）：共享 base 的归属与 group 守卫 ----
  const sharedBase = getRun(ids.runA).base_workspace.workspace_id;
  const baseStepsA = (happy.f.steps ?? []).filter((s) => s.action === "close_base_workspace");
  check(
    "runA 的共享 base 被 group 守卫保留（runKeep/runUnmerged 还挂着）",
    baseStepsA.length === 1 && baseStepsA[0].status === "kept" && /linked worktree/.test(baseStepsA[0].detail ?? ""),
    JSON.stringify(baseStepsA),
  );
  check("共享 base 还在", !!fakeState().workspaces[sharedBase]);
  check(
    "kept 必须给调用者明确的待重试提示（不是 done 就吞掉）",
    String(happy.f.kept_notice ?? "").includes(sharedBase) && /finalize_run again/.test(happy.f.kept_notice ?? ""),
    String(happy.f.kept_notice ?? "(missing)").slice(0, 160),
  );
  const logBase = JSON.parse(readFileSync(logPath, "utf8")).base_workspace;
  check(
    "run 日志保留 base 归属证据",
    logBase?.workspace_id === sharedBase && logBase?.created_by_run === true && !!logBase?.evidence,
    JSON.stringify(logBase).slice(0, 140),
  );
  const baseStepsB = (cleaned.f.steps ?? []).filter((s) => s.action === "close_base_workspace");
  check("runB 领养 base → skipped 不砸", baseStepsB.length === 1 && baseStepsB[0].status === "skipped", JSON.stringify(baseStepsB));

  const again = await mcpProbe({ args: ARGS, env: { ...ENV, HG_FAKE_RUN_LOG: happyLog }, calls: [fin("f", ids.runA)] });
  check("幂等重调不炸", again.f.isError !== true && again.f.cleanup_status === "done", JSON.stringify(again.f).slice(0, 120));
  check("重调认得已完成（already gone）", (again.f.steps ?? []).some((s) => String(s.detail).includes("already gone")), JSON.stringify(again.f.steps).slice(0, 160));
  check("尝试记录累加", JSON.parse(readFileSync(logPath, "utf8")).cleanup.attempts.length === 2);

  // ---- keep：标 accepted 但留现场；之后可以翻案成 auto ----
  const keep = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runKeep, { cleanup: "keep" })] });
  check("keep 标 accepted", keep.f.cleanup_status === "kept" && getRun(ids.runKeep).status === "accepted");
  check("keep 不动容器与分支", !!fakeState().workspaces[getRun(ids.runKeep).workspace_id] && branchExists("feat/keep"));
  check("keep 的 worker 也出闸（现场留着）", Object.values(registryFile().sessions).find((s) => s.run_id === ids.runKeep)?.status === "terminated");
  const flip = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runKeep, { cleanup: "auto" })] });
  check("keep→auto 翻案后重新核验并收干净", flip.f.cleanup_status === "done" && !branchExists("feat/keep"), JSON.stringify(flip.f).slice(0, 120));

  // ---- 基础 workspace（issue #13）：独占 / 预存在 / 被用户改动 ----
  const solo = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runSolo)] });
  const soloBase = getRun(ids.runSolo).base_workspace.workspace_id;
  check("runSolo finalize done", solo.f.cleanup_status === "done", JSON.stringify(solo.f).slice(0, 160));
  check(
    "runSolo 独占的 base 一并关闭",
    (solo.f.steps ?? []).some((s) => s.action === "close_base_workspace" && s.status === "done"),
    JSON.stringify(solo.f.steps),
  );
  check("runSolo 的 base 真没了", !fakeState().workspaces[soloBase], Object.keys(fakeState().workspaces).join(","));
  check("runSolo 分支已删", !branchExistsIn(repo2, "feat/solo"));
  check("全收干净时没有 kept_notice", solo.f.kept_notice == null, JSON.stringify(solo.f.kept_notice ?? "(none)"));

  const pre = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runPre)] });
  check(
    "预存在 base → skipped 且 finalize 仍 done",
    pre.f.cleanup_status === "done" && (pre.f.steps ?? []).some((s) => s.action === "close_base_workspace" && s.status === "skipped"),
    JSON.stringify(pre.f.steps),
  );
  check("预存在的 wPre 原样保留", !!fakeState().workspaces.wPre && !!fakeState().tabs["wPre:t1"]);
  check(
    "runPre 自己的容器与分支照收",
    !fakeState().workspaces[getRun(ids.runPre).workspace_id] && !branchExistsIn(repo3, "feat/pre"),
  );

  {
    // 「用户」在 runMod 的 base 里开了一个 tab：base 必须保留，run 自己的容器照收
    const s = fakeState();
    const baseId = getRun(ids.runMod).base_workspace.workspace_id;
    s.tabs["wX:tUser"] = { tab_id: "wX:tUser", workspace_id: baseId, label: "人开的 tab" };
    writeFakeState(s);
  }
  const mod = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runMod)] });
  const modBase = getRun(ids.runMod).base_workspace.workspace_id;
  check(
    "base 被动过 → kept，cleanup 仍 done",
    mod.f.cleanup_status === "done" && (mod.f.steps ?? []).some((s) => s.action === "close_base_workspace" && s.status === "kept"),
    JSON.stringify(mod.f.steps),
  );
  check("被动过的 base 与人的 tab 都在", !!fakeState().workspaces[modBase] && !!fakeState().tabs["wX:tUser"]);
  check(
    "runMod 自己的容器与分支照收",
    !fakeState().workspaces[getRun(ids.runMod).workspace_id] && !branchExistsIn(repo4, "feat/mod"),
  );

  // ---- fox：只收本 run 的 tab，宿主 workspace 一个指头都不碰 ----
  {
    // 给 fox 的第二个 tab 塞一个外来 pane：那个 tab 必须拒关，另一个照收
    const s = fakeState();
    const foxRun = getRun(ids.runFox);
    const tab2 = Object.entries(foxRun.stages).find(([, st]) => st.step === "s2")[0];
    s.panes["foreign-pane"] = { pane_id: "foreign-pane", tab_id: tab2, workspace_id: "w0" };
    writeFakeState(s);
  }
  const fox = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runFox)] });
  check("fox 收尾是 partial（一个 tab 有外来 pane）", fox.f.cleanup_status === "partial", JSON.stringify(fox.f).slice(0, 200));
  const foxRun = getRun(ids.runFox);
  const foxTab1 = Object.entries(foxRun.stages).find(([, st]) => st.step === "s1")[0];
  const foxTab2 = Object.entries(foxRun.stages).find(([, st]) => st.step === "s2")[0];
  check("fox 干净的 tab 照收", !fakeState().tabs[foxTab1]);
  check("fox 有外来 pane 的 tab 拒关", !!fakeState().tabs[foxTab2]);
  check("fox 绝不碰宿主 workspace 与人的 tab", !!fakeState().workspaces.w0 && !!fakeState().tabs["w0:t0"]);

  // ---- 跨 run 分离 ----
  check("没被动过的 run 现场完好", !!fakeState().workspaces[getRun(ids.runUnmerged).workspace_id] && branchExists("feat/unmerged"));
  check("共享 base 留到最后（runUnmerged 永不 finalize）", !!fakeState().workspaces[sharedBase]);
  check("分支删除只用 -d", !fakeState().calls.some((c) => c.includes("branch -D") || c.includes("branch --force")));
} finally {
  await closeSocket(socketServer);
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
