#!/usr/bin/env node
// 环节（tab）生命周期的验收。不碰 herdr——herdr 调用全部打桩，
// 测的是【标签怎么算、状态怎么变、什么时候写 registry】这套逻辑。
//
// 这四条都是 dogfood 时真出过问题的：
//   1. tab 分步创建，人看不到整个计划的形状
//   2. 第二次 run_plan 序号又从 1 开始，侧栏出现两个「1 xxx」
//   3. review 打回 impl 后，impl 那个 tab 还挂着 ✓
//   4. terminate 一个 worker 把整个容器连同兄弟一起收掉
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-stages-"));
mkdirSync(join(home, "state"), { recursive: true });
process.env.HERDGENT_HOME = home;

// ⚠️ markStageRunning 会调 herdr 去 rename tab。不指死 socket 的话，herdr CLI
// 会【回落到 default session】——也就是 GG 正在干活的那个。判据是结构性的：
// 这个进程必须根本连不上真 herdr，而不是「逻辑上应该不会走到那一步」。
// 空字符串不行（falsy，CLI 照样回落），必须是一个存在不了的路径。
process.env.HERDR_SOCKET_PATH = join(home, "no-such-herdr.sock");

const registry = await import(`../lib/registry.mjs?t=${Date.now()}`);

// ---- 序号：一个 run 一个容器，从 1 起 ----
//
// 2026-09-16 起每个 run 独占容器（不再按 ROOT 懒复用），所以编号没有「跨 run 连续」
// 的需求——共享容器才需要防重号，独占容器里每个 run 都从 1 起天经地义。
// 这是 run_plan 里算标签的规则，抄在这里当规格。
function stageLabels({ steps, container, spaceLabel }) {
  return steps.map((step, index) => {
    const no = index + 1;
    return container === "tab"
      ? `${spaceLabel} · ${no} ${step.title || step.id}`
      : `${no} ${step.title || step.id}`;
  });
}

{
  const steps = [{ id: "impl", title: "impl" }, { id: "review", title: "review" }];
  const first = stageLabels({ steps, container: "worktree" });
  check("每个 run 从 1 开始", JSON.stringify(first) === '["1 impl","2 review"]', first.join(" | "));

  // 第二个 run 在自己的容器里也从 1 起——不撞车是因为容器不共享，不是靠编号错开
  const second = stageLabels({ steps: [{ id: "fix", title: "fix" }], container: "worktree" });
  check("第二个 run 同样从 1 开始", second[0] === "1 fix", second[0]);

  // tab 模式的 tab 跟人自己的 tab 混在一个 space 里，必须带编排名
  const inTab = stageLabels({
    steps: [{ id: "survey", title: "survey" }],
    container: "tab",
    spaceLabel: "fox · 调研缓存",
  });
  check("tab 模式带编排名前缀", inTab[0] === "fox · 调研缓存 · 1 survey", inTab[0]);
}

// ---- 状态标记 ----
{
  const { setStageStatus } = await import(`../lib/worker.mjs?t=${Date.now()}`);
  check("setStageStatus 是函数", typeof setStageStatus === "function");
  // 标记本身要打到 herdr，这里只验字符集：五种状态必须【互不相同】，
  // 否则「没开始」和「跑挂了」在侧栏长得一样。
  const marks = ["☐", "⋯", "✓", "⚠", "✗"];
  check("五种状态标记互不相同", new Set(marks).size === 5, marks.join(""));
}

// ---- 状态可回退（registry 侧）----
{
  const root = "test-root";
  registry.putOrchestration(root, {
    stages: {
      t1: { label: "1 impl", step: "impl", status: "pending" },
      t2: { label: "2 review", step: "review", status: "pending" },
    },
  });

  // 跑完两步
  for (const [tab, st] of [["t1", "done"], ["t2", "done"]]) {
    registry.update((reg) => {
      reg.orchestrations[root].stages[tab].status = st;
    });
  }
  let stages = registry.getOrchestration(root).stages;
  check("两步都标了 done", stages.t1.status === "done" && stages.t2.status === "done");

  // review 打回 impl：impl 那个 tab 必须退回 running，且【标签还在】
  const { markStageRunning } = await import(`../lib/worker.mjs?t=${Date.now()}-2`);
  const label = markStageRunning(root, "t1");
  stages = registry.getOrchestration(root).stages;
  check("返工把环节退回 running", stages.t1.status === "running", stages.t1.status);
  check("退回时拿得到原标签", label === "1 impl", String(label));
  check("兄弟环节不受影响", stages.t2.status === "done", stages.t2.status);

  // 标签必须活在 registry 而不是 run_plan 的局部变量里——
  // 返工发生在 run_plan 返回【之后】，那时局部变量早没了。
  check("标签持久化在 registry", stages.t1.label === "1 impl", stages.t1.label);

  // 不认识的 tab 不该炸，也不该凭空造一条
  check("未知 tab 返回 null", markStageRunning(root, "no-such-tab") === null);
  check("未知 tab 不写脏数据", !registry.getOrchestration(root).stages["no-such-tab"]);
  check("tabId 为空时不炸", markStageRunning(root, null) === null);
}

// ---- 环节标签挂在 run 名下（现行布局）----
//
// 2026-09-16 起 stages 归 run 所有（ownership 的一部分），不再平铺在 orchestration 上。
// markStageRunning 两处都要能找到：新数据在 run 里，旧数据在 orchestration 平级。
{
  const root = "test-root-runs";
  registry.putRun(root, "run-a", {
    status: "running",
    stages: {
      t9: { label: "1 impl", step: "impl", status: "done", root_pane_id: "p9" },
    },
  });
  const { markStageRunning } = await import(`../lib/worker.mjs?t=${Date.now()}-3`);
  const label = markStageRunning(root, "t9");
  const run = registry.getRun(root, "run-a");
  check("run 里的环节能退回 running", run.stages.t9.status === "running", run.stages.t9.status);
  check("退回时拿得到 run 里的原标签", label === "1 impl", String(label));

  // 另一个 run 的同名 tab 互不干扰——跨 run 分离是 ownership 的底线
  registry.putRun(root, "run-b", {
    status: "running",
    stages: { t8: { label: "1 impl", step: "impl", status: "done", root_pane_id: "p8" } },
  });
  markStageRunning(root, "t8");
  check("别的 run 的环节各自回退", registry.getRun(root, "run-b").stages.t8.status === "running");
  check("run-a 不受 run-b 影响", registry.getRun(root, "run-a").stages.t9.status === "running");
  check("findStageByTab 认得两边", !!registry.findStageByTab(root, "t9")?.run && !!registry.findStageByTab(root, "t8")?.run);
}

rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
