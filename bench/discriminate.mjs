#!/usr/bin/env node
// 区分度筛选：哪些题值得投入重复运行，哪些当场淘汰。
//
//   node bench/discriminate.mjs
//
// 【这是 v2 的核心机制，不是附加分析】。
// 第一轮的教训不是「猜错了难度」—— 猜错难免；是猜错之后没有任何东西拦住它，
// 15 次运行（占全部的 43%）一路跑到底才发现前端三题五家全是满分。
//
// 所以流程改成两阶段：所有候选题先各跑 1 次算区分度，
// 极差 < 阈值的当场淘汰、不再投钱；活下来的才补到 n=3。
//
// 区分度 = 五家在该题主指标上的极差。
// 为什么用极差而不是标准差：这里问的是「最好和最差之间隔了多远」，
// 那正是「这道题能不能把 harness 分开」的直接问法。标准差会被中间的扎堆稀释掉。

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const RESULTS = join(HERE, "bench", "results");

// 低于这个极差就认为这道题分不出高下。
// 15% 不是拍的：第一轮 review-spread 的极差正好是 14%，而它的五家只落在两个值上
// （29% 和 14%）—— 因为标注只有 7 条，召回的最小刻度就是 14%，尺子只有两格。
// 那种题即使跑 n=3 也只会在两个值之间抖，投钱没有回报。
const MIN_SPREAD = 0.15;

// 主指标：这道题「做得好不好」的那一个数。
// 评审看召回（找全了多少真问题），前端看完成率。
const PRIMARY = {
  review: { key: (r) => r.line_recall, label: "召回" },
  frontend: { key: (r) => (r.solved ? 1 : 0), label: "完成率" },
};

const files = (await readdir(RESULTS).catch(() => [])).filter((f) => f.endsWith(".json") && f !== "SUMMARY.json");
const rows = [];
for (const f of files) {
  const kind = f.startsWith("review-") ? "review" : f.startsWith("frontend-") ? "frontend" : null;
  if (!kind) continue;
  for (const r of JSON.parse(await readFile(join(RESULTS, f), "utf8"))) {
    // 网关抖动那次不是能力表现。老记录没有这个字段，用「短到不可能真跑过 + 零产出」补判
    const infra = r.infraFailure !== undefined
      ? r.infraFailure
      : r.ms < 20_000 && (kind === "review" ? !r.parseOk && !r.total_generated : !r.specPassed && !r.filesChanged);
    if (!infra) rows.push({ ...r, kind });
  }
}

const byTask = new Map();
for (const r of rows) {
  if (!byTask.has(r.task)) byTask.set(r.task, []);
  byTask.get(r.task).push(r);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const verdicts = [];
for (const [task, list] of byTask) {
  const kind = list[0].kind;
  const { key, label } = PRIMARY[kind];
  const perHarness = new Map();
  for (const r of list) {
    const v = key(r);
    if (v === null || v === undefined) continue;
    if (!perHarness.has(r.harness)) perHarness.set(r.harness, []);
    perHarness.get(r.harness).push(v);
  }
  const vals = [...perHarness.entries()].map(([h, vs]) => ({ h, v: mean(vs), n: vs.length }));
  if (vals.length < 2) continue;
  const hi = Math.max(...vals.map((x) => x.v));
  const lo = Math.min(...vals.map((x) => x.v));
  const spread = hi - lo;

  // 分辨率：主指标的最小刻度。评审是 1/标注数，前端的完成率是二值的
  const gt = kind === "review" ? (list[0].positive_expected ?? null) : null;
  const step = kind === "review" && gt ? 1 / gt : 1;
  const distinct = new Set(vals.map((x) => x.v.toFixed(4))).size;

  verdicts.push({
    task, kind, label, spread, distinct, step, gt,
    harnesses: vals.length,
    n: Math.min(...vals.map((x) => x.n)),
    keep: spread >= MIN_SPREAD,
    vals: vals.sort((a, b) => b.v - a.v),
  });
}

verdicts.sort((a, b) => b.spread - a.spread);

console.log(`区分度筛选（阈值 ${(MIN_SPREAD * 100).toFixed(0)}%）\n`);
console.log(`${"题".padEnd(17)}${"指标".padEnd(8)}${"极差".padStart(7)}${"档位".padStart(6)}${"刻度".padStart(7)}  取值`);
for (const v of verdicts) {
  const vals = v.vals.map((x) => `${x.h.slice(0, 2)}${(x.v * 100).toFixed(0)}`).join(" ");
  const stepTxt = v.gt ? `${(v.step * 100).toFixed(0)}%` : "二值";
  console.log(
    `${v.task.padEnd(17)}${v.label.padEnd(8)}${`${(v.spread * 100).toFixed(0)}%`.padStart(7)}` +
      `${String(v.distinct).padStart(6)}${stepTxt.padStart(7)}  ${vals}`,
  );
}

const keep = verdicts.filter((v) => v.keep);
const drop = verdicts.filter((v) => !v.keep);

console.log(`\n值得投入 n=3（${keep.length} 题）：${keep.map((v) => v.task).join(", ") || "（无）"}`);

// 【极差够也不一定可信】：档位太少时，那个「极差」很可能只是尺子上相邻的两三格，
// 多跑几次就会在这几格之间抖。review-baseline 就是这样 ——
// 极差 20% 看着过关，但它只有 5 条标注、刻度也是 20%，实际只有 3 档。
// 这种题该做的不是加 n，是换成标注更多的题。
const MIN_LEVELS = 4;
const shaky = keep.filter((v) => v.distinct < MIN_LEVELS);
if (shaky.length) {
  console.log(`\n⚠ 极差达标但分辨率可疑（档位 < ${MIN_LEVELS}）：`);
  for (const v of shaky) {
    console.log(
      `  ${v.task.padEnd(17)} 只有 ${v.distinct} 档` +
        (v.gt ? `（标注 ${v.gt} 条、刻度 ${(v.step * 100).toFixed(0)}%）` : "") +
        ` —— 极差可能只是相邻两三格，先换标注 ≥ 12 条的题再谈加 n`,
    );
  }
}
if (drop.length) {
  console.log(`淘汰（${drop.length} 题）：`);
  for (const v of drop) {
    // 分不出高下有两种原因，处方完全不同 —— 不能混为一谈
    const reason = v.distinct === 1
      ? "五家取值完全相同 —— 题目太简单或太难，换题"
      : v.gt && v.spread <= v.step * 1.5
        ? `尺子只有 ${v.distinct} 格（标注 ${v.gt} 条、刻度 ${(v.step * 100).toFixed(0)}%）—— 换标注更多的题，不是换难度`
        : "差距落在噪声里 —— 补几次看看是真分不出还是方差盖住了";
    console.log(`  ${v.task.padEnd(17)} ${reason}`);
  }
}

const wasted = drop.reduce((s, v) => s + byTask.get(v.task).length, 0);
if (wasted) {
  console.log(
    `\n这些题上已经花掉 ${wasted} 次运行（占 ${((wasted / rows.length) * 100).toFixed(0)}%）。` +
      `两阶段流程下，它们会在第 5 次（五家各 1 次）之后就被拦住。`,
  );
}
