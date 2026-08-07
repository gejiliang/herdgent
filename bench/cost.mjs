#!/usr/bin/env node
// 按 deepseek-v4-flash 的实际价目算钱。
//
//   node bench/cost.mjs
//
// 【成本由 output 决定，不是 input】：输出 2 元/百万，而输入命中缓存只要 0.02 元 ——
// 差 100 倍。所以「谁读得多」几乎不影响账单，「谁说得多」才影响。
// 实测 codex 吞了 510 万缓存命中，听着吓人，实际只花 0.10 元；
// claude 读进去的最少（未命中 input 40,619，五家最低）却最贵，
// 因为它 output 120,903 是别家的 2–3 倍，光 output 就占了成本的 66%。

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { excluded } from "./lib/exclude.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

// 元 / 百万 tokens
export const PRICE = { inputMiss: 1.0, inputHit: 0.02, output: 2.0 };

export function costOf(t) {
  if (!t) return null;
  return (
    ((t.input ?? 0) * PRICE.inputMiss +
      (t.cached ?? 0) * PRICE.inputHit +
      (t.output ?? 0) * PRICE.output) / 1e6
  );
}

// 【只在直接运行时才打印报告】。matrix.mjs 要 import 上面的 costOf/PRICE，
// 顶层直接执行的话，一 import 就把整份成本报告打印一遍 ——
// build.mjs 和 report.mjs 都栽过同一个坑。
async function main() {
  const median = (a) => {
    const v = [...a].sort((x, y) => x - y);
    return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  };

  const rows = [];
  for (const f of (await readdir(RESULTS).catch(() => []))) {
    if (!f.endsWith(".json") || f === "SUMMARY.json") continue;
    let d;
    try {
      d = JSON.parse(await readFile(join(RESULTS, f), "utf8"));
    } catch {
      continue;
    }
    for (const r of d) {
      if (!r.tokens) continue;
      if (await excluded(r)) continue;
      rows.push(r);
    }
  }

  console.log(
    `价目：命中缓存 ${PRICE.inputHit} 元/M · 未命中 ${PRICE.inputMiss} 元/M · 输出 ${PRICE.output} 元/M\n` +
      `带计量的运行 ${rows.length} 次\n`,
  );

  const byTask = new Map();
  for (const r of rows) {
    if (!byTask.has(r.task)) byTask.set(r.task, []);
    byTask.get(r.task).push(r);
  }

  for (const [task, list] of byTask) {
    const per = new Map();
    for (const r of list) {
      if (!per.has(r.harness)) per.set(r.harness, []);
      per.get(r.harness).push(r);
    }
    if (per.size < 2) continue;
    console.log(`── ${task} （每次运行中位数）──`);
    const out = [...per.entries()].map(([h, v]) => ({
      h,
      n: v.length,
      cost: median(v.map((r) => costOf(r.tokens))),
      outShare: median(v.map((r) => ((r.tokens.output ?? 0) * PRICE.output) / 1e6 / (costOf(r.tokens) || 1))),
    }));
    out.sort((a, b) => b.cost - a.cost);
    for (const o of out) {
      console.log(`  ${o.h.padEnd(9)} n=${o.n}  ${o.cost.toFixed(4)} 元   output 占 ${(o.outShare * 100).toFixed(0)}%`);
    }
    const hi = out[0].cost, lo = out[out.length - 1].cost;
    console.log(`  最贵/最便宜 = ${(hi / lo).toFixed(1)}x\n`);
  }

  const tot = new Map();
  for (const r of rows) tot.set(r.harness, (tot.get(r.harness) ?? 0) + costOf(r.tokens));
  const grand = [...tot.values()].reduce((a, b) => a + b, 0);
  console.log("── 累计花费 ──");
  for (const [h, c] of [...tot].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${h.padEnd(9)} ${c.toFixed(2)} 元`);
  }
  console.log(`  合计      ${grand.toFixed(2)} 元`);

}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
