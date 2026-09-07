#!/usr/bin/env node
// 统一对比表：四类任务 × 五家 × 正确率 / 用时 / 成本。
//
//   node bench/matrix.mjs           # 终端表
//   node bench/matrix.mjs --json    # 喂给网页那一步
//
// 【只统计统一配置之后的运行】。此前的数据 effort 档位和输出模式都不一致，
// 混进来算成本就是拿不同条件的数字做比较。哪些被排除、为什么，见 exclude.json。
//
// 各类任务的「正确率」不是同一个量，不能跨类比大小：
//   定位   文件召回 —— 该找的地方找到没有
//   评审   行号级召回 —— 该报的问题报出来多少
//   前端   完成率 —— 测试全过 且 没改测试文件
//   约束   守规率 —— 有没有越过文件边界
// 表里同列并排只是为了看「同一家在不同类型上的表现」，不是让四个数排名次。

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { excluded } from "./lib/exclude.mjs";
import { costOf, PRICE } from "./cost.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const HARNESSES = ["claude", "codex", "opencode", "pi", "kimi"];

// 只认统一配置之后的数据。时间戳来自「五家 effort 统一 + 输出模式统一」那次提交之后的首次运行。
const UNIFIED_AFTER = Date.parse("2026-08-06T00:00:00Z");

const CATEGORIES = [
  {
    id: "locate", label: "定位", metric: "文件召回",
    tasks: ["loc-baseline", "loc-hard"],
    score: (r) => r.file_recall,
  },
  {
    id: "review", label: "评审", metric: "行号召回",
    tasks: ["review-hard"],
    score: (r) => r.line_recall,
  },
  {
    id: "frontend", label: "前端", metric: "完成率",
    tasks: ["fe2-baseline", "fe2-spread", "fe2-hard"],
    score: (r) => (r.solved ? 1 : 0),
  },
  {
    id: "constraint", label: "约束", metric: "守规率",
    tasks: ["con-readonly", "con-scoped", "con-conflict"],
    score: (r) => (r.violated ? 0 : 1),
  },
];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const v = [...a].sort((x, y) => x - y);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

const rows = [];
for (const f of (await readdir(RESULTS).catch(() => []))) {
  if (!f.endsWith(".json") || f === "SUMMARY.json") continue;
  const path = join(RESULTS, f);
  let d;
  try {
    d = JSON.parse(await readFile(path, "utf8"));
  } catch {
    continue;
  }
  const { mtime } = await (await import("node:fs/promises")).stat(path);
  if (mtime.getTime() < UNIFIED_AFTER) continue;
  for (const r of d) {
    if (await excluded(r)) continue;
    rows.push(r);
  }
}

const cell = (cat, h) => {
  const sub = rows.filter((r) => cat.tasks.includes(r.task) && r.harness === h);
  if (!sub.length) return null;
  const scores = sub.map(cat.score).filter((v) => v !== null && v !== undefined);
  const costs = sub.map((r) => costOf(r.tokens)).filter((v) => v !== null);
  return {
    n: sub.length,
    score: mean(scores),
    seconds: median(sub.map((r) => r.ms / 1000)),
    cost: costs.length ? mean(costs) : null,
    timedOut: sub.filter((r) => r.timedOut).length,
  };
};

const matrix = CATEGORIES.map((c) => ({
  ...c,
  cells: Object.fromEntries(HARNESSES.map((h) => [h, cell(c, h)])),
}));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ matrix, price: PRICE, harnesses: HARNESSES }, null, 2));
  process.exit(0);
}

const pct = (v) => (v === null ? "  — " : `${(v * 100).toFixed(0)}%`.padStart(4));
const sec = (v) => (v === null ? "  — " : `${v.toFixed(0)}s`.padStart(5));
const yuan = (v) => (v === null ? "   — " : v.toFixed(3).padStart(5));

console.log(`统一配置后的运行 ${rows.length} 次 · 价目 命中 ${PRICE.inputHit} / 未命中 ${PRICE.inputMiss} / 输出 ${PRICE.output} 元每百万\n`);

for (const c of matrix) {
  console.log(`── ${c.label}（${c.metric}）· ${c.tasks.length} 道题 ──`);
  console.log(`${"harness".padEnd(10)}${"n".padStart(3)}${"正确率".padStart(7)}${"用时".padStart(8)}${"成本".padStart(9)}${"".padStart(3)}`);
  const list = HARNESSES.map((h) => ({ h, ...(c.cells[h] ?? {}) })).filter((x) => x.n);
  list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.cost ?? 0) - (b.cost ?? 0));
  for (const x of list) {
    console.log(
      `${x.h.padEnd(10)}${String(x.n).padStart(3)}${pct(x.score).padStart(7)}${sec(x.seconds).padStart(8)}` +
        `${yuan(x.cost).padStart(8)}元${x.timedOut ? `  ⚠${x.timedOut} 次超时` : ""}`,
    );
  }
  console.log();
}

// 总账：每家在全部四类上的合计
console.log("── 全部任务合计 ──");
console.log(`${"harness".padEnd(10)}${"次数".padStart(5)}${"总用时".padStart(9)}${"总成本".padStart(9)}`);
for (const h of HARNESSES) {
  const sub = rows.filter((r) => r.harness === h);
  if (!sub.length) continue;
  const t = sub.reduce((s, r) => s + r.ms / 1000, 0);
  const c = sub.reduce((s, r) => s + (costOf(r.tokens) ?? 0), 0);
  console.log(`${h.padEnd(10)}${String(sub.length).padStart(5)}${`${(t / 60).toFixed(0)}min`.padStart(9)}${c.toFixed(2).padStart(8)}元`);
}
