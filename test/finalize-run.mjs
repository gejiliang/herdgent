#!/usr/bin/env node
// finalize_run 验收：显式验收、git 核验、归属扫描、幂等重试、跨 run 分离。
//
// 安全路径是这里的被测主体，一个都不能少：
//   未合并拒删 / 脏拒删 / 外来 tab/pane 拒删 / fox 不碰宿主 workspace /
//   keep 也标 accepted / 分支只用 -d / 先落盘再动手 / 部分失败可重试。
// herdr 是假 CLI + 假事件 socket（test/fake-herdr.mjs）；git 用本地临时真仓库。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const registryFile = () => JSON.parse(readFileSync(join(state, "registry.json"), "utf8"));
const fakeState = () => JSON.parse(readFileSync(fake.statePath, "utf8"));
const writeFakeState = (s) => writeFileSync(fake.statePath, JSON.stringify(s, null, 2));
const getRun = (id) => registryFile().orchestrations["orc-test"].runs[id];
const fin = (key, run_id, extra = {}) => ({ key, name: "finalize_run", arguments: { run_id, verdict: "accept", evidence: EVIDENCE, ...extra } });
const rexCall = (key, branch) => ({
  key,
  name: "run_plan",
  arguments: { label: key, branch, repo, steps: [{ id: "impl", title: "impl", profile: "test-impl", task: `do ${key}` }] },
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
    ["runA", "runB", "runKeep", "runForeign", "runUnmerged", "runFox"].map((k) => [k, setup[k].run_id]),
  );
  check("六个 run 都跑完", Object.values(setup).every((x) => x.completed === true), JSON.stringify(Object.keys(ids)));

  // ---- 拒绝路径：未合并 / 缺证据 / 坏 verdict ----
  const refuse = await mcpProbe({
    args: ARGS,
    env: ENV,
    calls: [
      fin("notMerged", ids.runUnmerged),
      { key: "noEvidence", name: "finalize_run", arguments: { run_id: ids.runA, verdict: "accept" } },
      { key: "badVerdict", name: "finalize_run", arguments: { run_id: ids.runA, verdict: "reject", evidence: EVIDENCE } },
      { key: "noRun", name: "finalize_run", arguments: { run_id: "run-nope", verdict: "accept", evidence: EVIDENCE } },
    ],
  });
  check("未合并拒绝", refuse.notMerged.isError && refuse.notMerged.error === "not_merged", JSON.stringify(refuse.notMerged));
  check("未合并的 run 没有被验收", getRun(ids.runUnmerged).status === "completed", getRun(ids.runUnmerged).status);
  check("未合并的现场原样保留", !!fakeState().workspaces[getRun(ids.runUnmerged).workspace_id] && branchExists("feat/unmerged"));
  check("缺证据拒绝", refuse.noEvidence.isError && refuse.noEvidence.error === "evidence_required", JSON.stringify(refuse.noEvidence));
  check("坏 verdict 拒绝", refuse.badVerdict.isError && refuse.badVerdict.error === "bad_verdict", JSON.stringify(refuse.badVerdict));
  check("finalize 也守归属边界", refuse.noRun.isError && refuse.noRun.error === "run_not_found", JSON.stringify(refuse.noRun));

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
  {
    const s = fakeState();
    const ws = getRun(ids.runForeign).workspace_id;
    s.tabs["wX:tForeign"] = { tab_id: "wX:tForeign", workspace_id: ws, label: "人手加的" };
    writeFakeState(s);
  }
  const foreign = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runForeign)] });
  check("外来 tab 拒删", foreign.f.isError !== true && foreign.f.cleanup_status === "refused_foreign", JSON.stringify(foreign.f).slice(0, 200));
  check("外来 tab 时验收已落盘（完成与现场分离）", getRun(ids.runForeign).status === "accepted", getRun(ids.runForeign).status);
  check("拒删时容器与分支都还在", !!fakeState().workspaces[getRun(ids.runForeign).workspace_id] && branchExists("feat/foreign"));
  {
    const s = fakeState();
    delete s.tabs["wX:tForeign"];
    writeFakeState(s);
  }
  const foreignRetry = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runForeign)] });
  check("挪走外来 tab 后重试清干净", foreignRetry.f.cleanup_status === "done", JSON.stringify(foreignRetry.f).slice(0, 120));
  check("重试后容器与分支收掉", !fakeState().workspaces[getRun(ids.runForeign).workspace_id] && !branchExists("feat/foreign"));

  // ---- happy path auto + 幂等 ----
  const happy = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runA)] });
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

  const again = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", ids.runA)] });
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
  check("分支删除只用 -d", !fakeState().calls.some((c) => c.includes("branch -D") || c.includes("branch --force")));
} finally {
  await closeSocket(socketServer);
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
