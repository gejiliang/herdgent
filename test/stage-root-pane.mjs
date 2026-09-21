#!/usr/bin/env node
// issue #14 验收：预建 stage root pane 的归属。
//
// 复现链：run_plan 一次建齐 impl/review 两个 tab → impl 起不来（等价于
// 「计划在 review 开始前停止」，超时/ blocked 同构）→ 人工 spawn_worker 追加
// review → finalize。
//
// 被测主体：
//   A. 未启动阶段的 root 可证实空闲 → 追加【复用】它（不 split），finalize 正常收；
//      用户新增的 pane 仍然拒删（foreign），挪走后重试成功
//   B. root 被「用户」占用（前台在跑东西）→ 追加保守 split，finalize 拒删不误清；
//      用户离开后重试，root 经现查证明未被使用 → 收干净
//   C. root 里有「用户 agent」→ 追加保守 split，finalize 拒删，现场原样保留
//   E. fox：同一条复用链跨容器形态成立；s3 的 workerless root 经现查算 owned 照收；
//      有外来 pane 的 tab 拒关；宿主 workspace 一个指头都不碰
//
// 安全重点：绝不把任意 pane 认领进 run——复用与收尾都以创建回执
// （stages[tab].root_pane_id / root_pane_cwd）+ 现查状态（provePaneUnused）为准。
//
// herdr 是假 CLI + 假事件 socket（test/fake-herdr.mjs），这个进程【根本连不上】
// 真 herdr；socket 与 state 全部指向临时目录（非空隔离）。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setupFakeHerdr, startEventSocket, closeSocket, writePiTranscript, mcpProbe } from "./fake-herdr.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-stage-root-"));
const state = join(home, "state");
const config = join(home, "config");
mkdirSync(state, { recursive: true });
mkdirSync(config, { recursive: true });
const fake = setupFakeHerdr(home);
const socket = join(home, "fake-herdr.sock");
const transcript = join(home, "transcript.jsonl");
writePiTranscript(transcript, ["review done"]);

const repo = join(home, "repo");
mkdirSync(repo);
const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", ".");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init");
for (const b of ["feat/sr-a", "feat/sr-b", "feat/sr-c"]) git("branch", b);
const branchExists = (name) => git("branch", "--list", name).stdout.trim() !== "";

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
const EVIDENCE = { review: "review PASS", acceptance: "我亲自核对了" };
const registryFile = () => JSON.parse(readFileSync(join(state, "registry.json"), "utf8"));
const fakeState = () => JSON.parse(readFileSync(fake.statePath, "utf8"));
const writeFakeState = (s) => writeFileSync(fake.statePath, JSON.stringify(s, null, 2));
const getRun = (id) => registryFile().orchestrations["orc-test"].runs[id];
const stageOf = (id, step) => Object.entries(getRun(id).stages).find(([, s]) => s.step === step);
const splitCalls = () => fakeState().calls.filter((c) => c.startsWith("pane split")).length;
const fin = (key, run_id) => ({ key, name: "finalize_run", arguments: { run_id, verdict: "accept", evidence: EVIDENCE } });
// 「计划在 review 开始前停止」：impl 的 agent 起不来（HG_FAKE_FAIL_AGENT_START），
// run 以 failed 收场，review tab 已预建但从没派过 worker——与超时同构。
const stalledRexPlan = (key, branch) => ({
  key,
  name: "run_plan",
  arguments: {
    label: key,
    branch,
    repo,
    steps: [
      { id: "impl", title: "impl", profile: "test-impl", task: `impl of ${key}` },
      { id: "review", title: "review", profile: "test-impl", task: `review of ${key}` },
    ],
  },
});

const socketServer = await startEventSocket(socket);
try {
  // ================= A. 未启动阶段 → 追加复用预建 root → finalize（issue 复现） =================
  const planA = await mcpProbe({
    args: ARGS,
    env: { ...ENV, HG_FAKE_FAIL_AGENT_START: "1" },
    calls: [stalledRexPlan("runA", "feat/sr-a")],
  });
  const runA = planA.runA.run_id;
  check("A: 计划停在 impl（review 从未开始）", planA.runA.completed === false && planA.runA.stopped_at === "impl", JSON.stringify(planA.runA).slice(0, 120));
  const [reviewTabA, reviewStageA] = stageOf(runA, "review");
  check(
    "A: 两个 stage tab 都预建且登记了 root pane 与创建回执 cwd",
    Object.keys(getRun(runA).stages).length === 2 && !!reviewStageA.root_pane_id && !!reviewStageA.root_pane_cwd,
    JSON.stringify(reviewStageA),
  );
  check(
    "A: review 的预建 root 没有 worker 行",
    !Object.values(registryFile().sessions).some((w) => w.pane_id === reviewStageA.root_pane_id),
  );

  const splitsBeforeA = splitCalls();
  const appendA = await mcpProbe({
    args: ARGS,
    env: ENV,
    calls: [
      { key: "append", name: "spawn_worker", arguments: { run_id: runA, step_id: "review", title: "人工补评审", profile: "test-impl", task: "补一轮评审" } },
    ],
  });
  check("A: 追加成功", appendA.append.isError !== true && !!appendA.append.worker_id, JSON.stringify(appendA.append).slice(0, 120));
  check(
    "A: 追加【复用】了预建 root pane，没有 split",
    appendA.append.pane_id === reviewStageA.root_pane_id && splitCalls() === splitsBeforeA,
    `pane=${appendA.append.pane_id} root=${reviewStageA.root_pane_id} splits=${splitCalls() - splitsBeforeA}`,
  );
  const workerA = Object.values(registryFile().sessions).find((s) => s.slug === appendA.append.worker_id);
  check("A: 复用的 worker 归属完整（run/step/tab/pane）", workerA?.run_id === runA && workerA?.step_id === "review" && workerA?.tab_id === reviewTabA && workerA?.pane_id === reviewStageA.root_pane_id);
  check("A: 追加后 review 环节退回 running", getRun(runA).stages[reviewTabA].status === "running", getRun(runA).stages[reviewTabA].status);

  // 用户后来在容器里加了一个 pane：必须仍然拒删（外来 pane 保护不回退）
  {
    const s = fakeState();
    s.panes["foreign-pane-a"] = { pane_id: "foreign-pane-a", tab_id: reviewTabA, workspace_id: getRun(runA).workspace_id };
    writeFakeState(s);
  }
  const finA1 = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", runA)] });
  check("A: 有外来 pane 时 finalize 拒删", finA1.f.cleanup_status === "refused_foreign", JSON.stringify(finA1.f).slice(0, 160));
  check("A: 拒删时容器与分支都在", !!fakeState().workspaces[getRun(runA).workspace_id] && branchExists("feat/sr-a"));
  {
    const s = fakeState();
    delete s.panes["foreign-pane-a"];
    writeFakeState(s);
  }
  const finA2 = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", runA)] });
  check("A: 挪走外来 pane 后重试清干净", finA2.f.cleanup_status === "done", JSON.stringify(finA2.f).slice(0, 160));
  // 2026-09-21 起底座常设：finalize 收容器与分支，底座留着给后续 run。
  check("A: 容器与分支收掉，自建底座留着（常设）", !fakeState().workspaces[getRun(runA).workspace_id] && !branchExists("feat/sr-a") && !!fakeState().workspaces[getRun(runA).base_workspace.workspace_id]);

  // ================= B. root 被「用户」占用 → 保守 split + 拒删；用户离开后重试成功 =================
  const planB = await mcpProbe({
    args: ARGS,
    env: { ...ENV, HG_FAKE_FAIL_AGENT_START: "1" },
    calls: [stalledRexPlan("runB", "feat/sr-b")],
  });
  const runB = planB.runB.run_id;
  const [, reviewStageB] = stageOf(runB, "review");
  {
    // 「用户」在 review 的预建 root 里跑了个 vim
    const s = fakeState();
    s.panes[reviewStageB.root_pane_id].foreground = [{ name: "vim" }];
    writeFakeState(s);
  }
  const splitsBeforeB = splitCalls();
  const appendB = await mcpProbe({
    args: ARGS,
    env: ENV,
    calls: [
      { key: "append", name: "spawn_worker", arguments: { run_id: runB, step_id: "review", title: "补评审", profile: "test-impl", task: "补一轮评审" } },
    ],
  });
  check(
    "B: root 被人用着 → 追加【保守 split】，不复用不认领",
    appendB.append.pane_id && appendB.append.pane_id !== reviewStageB.root_pane_id && splitCalls() === splitsBeforeB + 1,
    `pane=${appendB.append.pane_id} root=${reviewStageB.root_pane_id}`,
  );
  const finB1 = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", runB)] });
  check("B: 被用过的 root 按外来处理 → 拒删", finB1.f.cleanup_status === "refused_foreign", JSON.stringify(finB1.f).slice(0, 200));
  check(
    "B: 拒删 detail 点名被用过的 stage root",
    (finB1.f.steps ?? []).some((s) => s.status === "refused" && String(s.detail).includes(reviewStageB.root_pane_id)),
    JSON.stringify(finB1.f.steps).slice(0, 240),
  );
  check("B: 用户的 root、容器、分支都原样保留", !!fakeState().panes[reviewStageB.root_pane_id] && !!fakeState().workspaces[getRun(runB).workspace_id] && branchExists("feat/sr-b"));
  {
    // 用户用完了，离开这个 pane（前台回到空 shell）
    const s = fakeState();
    delete s.panes[reviewStageB.root_pane_id].foreground;
    writeFakeState(s);
  }
  const finB2 = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", runB)] });
  check("B: 用户离开后重试——root 现查未被使用 → 收干净", finB2.f.cleanup_status === "done", JSON.stringify(finB2.f).slice(0, 160));
  check("B: 容器与分支收掉，自建底座留着（常设）", !fakeState().workspaces[getRun(runB).workspace_id] && !branchExists("feat/sr-b") && !!fakeState().workspaces[getRun(runB).base_workspace.workspace_id]);

  // ================= C. root 里有「用户 agent」→ 保守 split + 拒删 =================
  const planC = await mcpProbe({
    args: ARGS,
    env: { ...ENV, HG_FAKE_FAIL_AGENT_START: "1" },
    calls: [stalledRexPlan("runC", "feat/sr-c")],
  });
  const runC = planC.runC.run_id;
  const [, reviewStageC] = stageOf(runC, "review");
  {
    // 「用户」在 review 的预建 root 里起了一个自己的 agent
    const s = fakeState();
    s.panes[reviewStageC.root_pane_id].agent = true;
    s.panes[reviewStageC.root_pane_id].agent_name = "user-own-agent";
    writeFakeState(s);
  }
  const appendC = await mcpProbe({
    args: ARGS,
    env: ENV,
    calls: [
      { key: "append", name: "spawn_worker", arguments: { run_id: runC, step_id: "review", title: "补评审", profile: "test-impl", task: "补一轮评审" } },
    ],
  });
  check(
    "C: root 里有用户 agent → 追加【保守 split】",
    appendC.append.pane_id && appendC.append.pane_id !== reviewStageC.root_pane_id,
    `pane=${appendC.append.pane_id} root=${reviewStageC.root_pane_id}`,
  );
  const finC = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", runC)] });
  check("C: 有用户 agent 的 root 按外来处理 → 拒删", finC.f.cleanup_status === "refused_foreign", JSON.stringify(finC.f).slice(0, 200));
  check(
    "C: 用户的 agent 与 root 原地保留，绝不误清",
    fakeState().panes[reviewStageC.root_pane_id]?.agent === true && !!fakeState().workspaces[getRun(runC).workspace_id] && branchExists("feat/sr-c"),
  );

  // ================= E. fox：同一条链跨容器形态成立，宿主不动 =================
  const planE = await mcpProbe({
    args: ARGS,
    env: { ...ENV, HG_FAKE_FAIL_AGENT_START: "1" },
    calls: [
      {
        key: "fox",
        name: "run_plan",
        arguments: {
          label: "调研",
          mode: "fox",
          repo,
          steps: [
            { id: "s1", title: "s1", profile: "test-impl", task: "看一" },
            { id: "s2", title: "s2", profile: "test-impl", task: "看二" },
            { id: "s3", title: "s3", profile: "test-impl", task: "看三" },
          ],
        },
      },
    ],
  });
  const runE = planE.fox.run_id;
  check("E: fox 计划停在 s1", planE.fox.completed === false && planE.fox.stopped_at === "s1", JSON.stringify(planE.fox).slice(0, 120));
  const [s2Tab, s2Stage] = stageOf(runE, "s2");
  const [s3Tab] = stageOf(runE, "s3");
  const splitsBeforeE = splitCalls();
  const appendE = await mcpProbe({
    args: ARGS,
    env: ENV,
    calls: [
      { key: "append", name: "spawn_worker", arguments: { run_id: runE, step_id: "s2", title: "补调研", profile: "test-impl", task: "补一份调研" } },
    ],
  });
  check(
    "E: fox 追加同样复用预建 root，不 split",
    appendE.append.pane_id === s2Stage.root_pane_id && splitCalls() === splitsBeforeE,
    `pane=${appendE.append.pane_id} root=${s2Stage.root_pane_id}`,
  );
  {
    // 「用户」往 s1 的 tab 里塞了一个 pane：那个 tab 必须拒关
    const s = fakeState();
    const [s1Tab] = stageOf(runE, "s1");
    s.panes["foreign-pane-e"] = { pane_id: "foreign-pane-e", tab_id: s1Tab, workspace_id: "w0" };
    writeFakeState(s);
  }
  const finE = await mcpProbe({ args: ARGS, env: ENV, calls: [fin("f", runE)] });
  check("E: fox 收尾 partial（s1 有外来 pane）", finE.f.cleanup_status === "partial", JSON.stringify(finE.f).slice(0, 200));
  const [s1TabE] = stageOf(runE, "s1");
  check("E: s2 的 tab 照收（复用的 root 归属完整）", !fakeState().tabs[s2Tab]);
  check("E: s3 的 workerless root 现查未被使用 → tab 照收", !fakeState().tabs[s3Tab]);
  check("E: s1 的 tab 与人的 pane 拒关保留", !!fakeState().tabs[s1TabE] && !!fakeState().panes["foreign-pane-e"]);
  check("E: 宿主 workspace 与人的 tab 一个指头都没碰", !!fakeState().workspaces.w0 && !!fakeState().tabs["w0:t0"]);
} finally {
  await closeSocket(socketServer);
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
