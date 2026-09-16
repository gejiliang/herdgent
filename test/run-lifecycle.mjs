#!/usr/bin/env node
// run 生命周期验收：一个 run 一个容器、中文 label 与 ASCII agent id 分离、
// 追加/重试落回原 tab、裸 spawn 被拒、repo 必须可核对。
//
// 全部走 MCP 协议真调 bin/mcp-server.mjs；herdr 是假 CLI + 假事件 socket
// （test/fake-herdr.mjs），这个进程【根本连不上】真 herdr。
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setupFakeHerdr, startEventSocket, closeSocket, writePiTranscript, mcpProbe } from "./fake-herdr.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-run-lifecycle-"));
const state = join(home, "state");
const config = join(home, "config");
mkdirSync(state, { recursive: true });
mkdirSync(config, { recursive: true });
const fake = setupFakeHerdr(home);
const socket = join(home, "fake-herdr.sock");
const transcript = join(home, "transcript.jsonl");
writePiTranscript(transcript, ["impl done"]);

// 真实 git 仓库（本地临时）：resolveRepo 要验它，finalize 的 merge-base 也要它。
const repo = join(home, "repo");
mkdirSync(repo);
const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", ".");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init");
git("branch", "feat/t1");
git("branch", "feat/t2");

// 测试 profile：走 pi 适配（transcript 直接给路径，免钩子）。
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
const registryFile = () => JSON.parse(readFileSync(join(state, "registry.json"), "utf8"));
const fakeState = () => JSON.parse(readFileSync(fake.statePath, "utf8"));
const runIds = () => Object.keys(registryFile().orchestrations["orc-test"]?.runs ?? {});
const getRun = (id) => registryFile().orchestrations["orc-test"].runs[id];

const socketServer = await startEventSocket(socket);
try {
  // 第一批：两个 rex run + 一个 fox run + 各类拒绝
  const r = await mcpProbe({
    args: ARGS,
    env: ENV,
    calls: [
      {
        key: "run1",
        name: "run_plan",
        arguments: {
          label: "思考能力统一",
          branch: "feat/t1",
          repo,
          steps: [{ id: "impl", title: "实现思考能力", profile: "test-impl", task: "把 thinking 等级统一了" }],
        },
      },
      {
        key: "run2",
        name: "run_plan",
        arguments: {
          label: "第二轮",
          branch: "feat/t2",
          repo,
          steps: [{ id: "impl", title: "impl", profile: "test-impl", task: "第二份活" }],
        },
      },
      // 裸 spawn 一律被拒
      { key: "bare", name: "spawn_worker", arguments: { title: "x", profile: "test-impl", task: "x" } },
      { key: "noRun", name: "spawn_worker", arguments: { run_id: "run-nope", step_id: "impl", title: "x", profile: "test-impl", task: "x" } },
      // repo 必须明确可核对
      {
        key: "badRepo",
        name: "run_plan",
        arguments: { repo: join(home, "no-such-dir"), steps: [{ profile: "test-impl", task: "x" }] },
      },
      {
        key: "notGit",
        name: "run_plan",
        arguments: { repo: home, steps: [{ profile: "test-impl", task: "x" }] },
      },
      // fox：只在发起者 workspace 加本 run 的 tab
      {
        key: "fox",
        name: "run_plan",
        arguments: {
          label: "调研缓存",
          mode: "fox",
          steps: [{ id: "survey", title: "survey", profile: "test-impl", task: "看看有几种缓存" }],
        },
      },
      { key: "runs", name: "list_runs" },
    ],
  });

  // ---- 一个 run 一个 worktree 容器 ----
  const [run1, run2] = runIds();
  check("run_plan 跑完", r.run1.completed === true && r.run2.completed === true, JSON.stringify(r.run1).slice(0, 120));
  check("run_id 返回并可用于后续调用", r.run1.run_id === run1 && r.run2.run_id === run2, `${run1} ${run2}`);
  const ws1 = getRun(run1).workspace_id;
  const ws2 = getRun(run2).workspace_id;
  check("两次 run 各自独立容器", ws1 && ws2 && ws1 !== ws2, `${ws1} vs ${ws2}`);
  const worktreeCreates = fakeState().calls.filter((c) => c.startsWith("worktree create"));
  check("每个 run 都真建了自己的 worktree", worktreeCreates.length === 2, worktreeCreates.join(" | "));
  // repo 以 git 解析出的主 checkout 为准（macOS 上 /var → /private/var，比 realpath 后的路径）
  check("run 台账登记了分支与 repo", getRun(run1).branch === "feat/t1" && getRun(run1).repo === realpathSync(repo), JSON.stringify(getRun(run1)).slice(0, 100));
  check("run 终态落盘", getRun(run1).status === "completed" && Array.isArray(getRun(run1).results), getRun(run1).status);
  check("list_runs 报得出三个 run", (r.runs.runs ?? []).length === 3, `${(r.runs.runs ?? []).length}`);
  check("完成回执指向 finalize_run", String(r.run1.next).includes("finalize_run"), String(r.run1.next).slice(0, 60));

  // ---- 中文 display label 与 ASCII agent id 分离 ----
  check(
    "workspace label 保留中文",
    worktreeCreates.some((c) => c.includes("rex · 思考能力统一")),
    worktreeCreates[0],
  );
  const agentStart = fakeState().calls.find((c) => c.startsWith("agent start"));
  const agentName = agentStart?.split(" ")[2] ?? "";
  check("agent 名是纯 ASCII slug", /^[a-z][a-z0-9-]*$/.test(agentName), agentName);
  const workerRow = Object.values(registryFile().sessions).find((s) => s.run_id === run1);
  check("worker 的展示 title 保留中文", String(workerRow?.title).includes("实现思考能力"), String(workerRow?.title));
  check("worker 登记了 run 与 step 归属", workerRow?.run_id === run1 && workerRow?.step_id === "impl");

  // ---- fox：只加 tab，不动宿主 workspace ----
  check("fox run 跑完", r.fox.completed === true, JSON.stringify(r.fox).slice(0, 120));
  const foxRun = getRun(r.fox.run_id);
  check("fox 容器是 tab 且无分支", foxRun.container === "tab" && !foxRun.branch, foxRun.container);
  check("fox 落在发起者的 workspace", foxRun.workspace_id === "w0", foxRun.workspace_id);
  const foxTabs = Object.values(fakeState().tabs).filter((t) => t.workspace_id === "w0");
  check("fox 的 tab 名带编排名与环节", foxTabs.some((t) => t.label.includes("fox · 调研缓存 · 1 survey")), foxTabs.map((t) => t.label).join(" | "));
  check("fox 没有新建 workspace", Object.keys(fakeState().workspaces).length === 3, Object.keys(fakeState().workspaces).join(","));

  // ---- 裸 spawn 与错误归属 ----
  check("裸 spawn 被拒", r.bare.isError && r.bare.error === "run_id_required", JSON.stringify(r.bare));
  check("别人的 run 查无此人", r.noRun.isError && r.noRun.error === "run_not_found", JSON.stringify(r.noRun));

  // ---- repo 必须可核对 ----
  check("不存在的 repo 被拒", r.badRepo.isError && r.badRepo.error === "repo_not_found", JSON.stringify(r.badRepo));
  check("非 git 目录不能开 rex", r.notGit.isError && r.notGit.error === "repo_not_git", JSON.stringify(r.notGit));

  // 第二批：追加/重试，用真实的 run1 id
  const r2 = await mcpProbe({
    args: ARGS,
    env: ENV,
    calls: [
      {
        key: "append",
        name: "spawn_worker",
        arguments: { run_id: run1, step_id: "impl", title: "补一道复核", profile: "test-impl", task: "复查一遍" },
      },
      { key: "noStep", name: "spawn_worker", arguments: { run_id: run1, step_id: "nope", title: "x", profile: "test-impl", task: "x" } },
    ],
  });

  // ---- 追加/重试复用 run 与 step ----
  check("追加成功", r2.append.isError !== true && !!r2.append.worker_id, JSON.stringify(r2.append).slice(0, 120));
  check("追加的 worker 落在原 run/step", r2.append.run_id === run1 && r2.append.step_id === "impl", JSON.stringify(r2.append).slice(0, 80));
  const appendRow = Object.values(registryFile().sessions).find((s) => s.slug === r2.append.worker_id);
  const stageTab = Object.entries(getRun(run1).stages).find(([, s]) => s.step === "impl")?.[0];
  check("追加的 pane 开在原 tab 里", appendRow?.tab_id === stageTab && fakeState().panes[appendRow?.pane_id]?.tab_id === stageTab, `tab=${appendRow?.tab_id}`);
  check("追加后环节退回 running", getRun(run1).stages[stageTab].status === "running", getRun(run1).stages[stageTab].status);
  check("追加没有新建容器", fakeState().calls.filter((c) => c.startsWith("worktree create")).length === 2);
  check("追加的 worker 也登记了归属", appendRow?.run_id === run1 && appendRow?.step_id === "impl");
  check("run 里没有这个 step", r2.noStep.isError && r2.noStep.error === "step_not_found", JSON.stringify(r2.noStep));

  // ---- fox 需要编排者在 workspace 里 ----
  const noPane = await mcpProbe({
    args: ARGS,
    env: { ...ENV, HERDR_PANE_ID: "" },
    calls: [{ key: "fox", name: "run_plan", arguments: { mode: "fox", steps: [{ profile: "test-impl", task: "x" }] } }],
  });
  check("无 pane 的 fox 明确报错", noPane.fox.isError && noPane.fox.error === "no_current_space", JSON.stringify(noPane.fox));
} finally {
  await closeSocket(socketServer);
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
