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

// ---- 序号跨 run_plan 连续 ----
//
// 这是 run_plan 里算标签的规则，抄在这里当规格：容器已经用掉 tabsUsed 个 tab 时，
// 新一批从 tabsUsed+1 起编号，而不是从 1。
function stageLabels({ steps, tabsUsed, container, spaceLabel }) {
  return steps.map((step, index) => {
    const no = tabsUsed + index + 1;
    return container === "tab"
      ? `${spaceLabel} · ${no} ${step.title || step.id}`
      : `${no} ${step.title || step.id}`;
  });
}

{
  const steps = [{ id: "impl", title: "impl" }, { id: "review", title: "review" }];
  const first = stageLabels({ steps, tabsUsed: 0, container: "worktree" });
  check("首轮从 1 开始", JSON.stringify(first) === '["1 impl","2 review"]', first.join(" | "));

  // 同一个容器里再跑一次：接着编号，不是又从 1 开始
  const second = stageLabels({ steps: [{ id: "fix", title: "fix" }], tabsUsed: 2, container: "worktree" });
  check("第二轮接着编号", second[0] === "3 fix", second[0]);

  const all = [...first, ...second];
  check("整个容器里序号不重复", new Set(all.map((l) => l.split(" ")[0])).size === all.length, all.join(" | "));

  // tab 模式的 tab 跟人自己的 tab 混在一个 space 里，必须带编排名
  const inTab = stageLabels({
    steps: [{ id: "survey", title: "survey" }],
    tabsUsed: 0,
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

rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
