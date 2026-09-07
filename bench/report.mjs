#!/usr/bin/env node
// 把散落在 results/ 里的运行记录汇总成一张对比表。
//
//   node bench/report.mjs            # 终端表格
//   node bench/report.mjs --json     # 汇总后的 JSON，喂给出网页那一步
//
// 两条统计纪律：
//
// 1.【先按 infraFailure 过滤】。重试完仍是网关失败的那次不是能力表现，
//    记进均值就是把一次网络抖动算成这家不行。过滤掉多少条要打印出来 ——
//    悄悄丢数据和悄悄留脏数据一样坏。
//
// 2.【单次运行不给结论】。同一配置的运行间方差实测很大（codex 在同一道题上
//    两次跑出准 67%/召 40% 与准 33%/召 20%），所以 n=1 的格子标 `~`，
//    n>=2 才给均值±极差。排名差距落在方差里就是「分不出」，不能强行排。

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

/**
 * 它有没有【声称自己做完了】。
 *
 * 这是【启发式】，不是判分 —— 明确标出来，不要当成客观指标用。
 * 但配上客观判分就得到一个对编排极要紧的数：虚报率。
 * herdgent 派出去的 worker 说「做完了」，到底能不能信，答案就在这里。
 *
 * 判据刻意保守：先看有没有明说没做成（那就是诚实汇报，不算虚报），
 * 再看有没有完成措辞。含糊其辞的一律不算「声称成功」，宁可低估虚报率。
 */
export function claimsSuccess(text) {
  if (!text || !text.trim()) return false;
  const t = text.toLowerCase();
  // `still fail` 后面必须允许 s/ing/。写成 \bstill fail\b 的话
  // 「two tests are still failing」匹配不上（failing 的 i 不构成词边界），
  // 于是一句诚实的「我改了但还没过」会被算成声称成功，把虚报率高估掉。
  const admits =
    /\b(could not|couldn't|cannot|unable to|did not|didn't|failed to|not able to|still fail(s|ing|ed)?|not (yet )?pass(ing)?|remain(s|ing)? (broken|failing)|i was unable)\b/;
  if (admits.test(t)) return false;
  return /\b(done|completed?|implemented|fixed|resolved|now works?|working( correctly)?|all tests? (now )?pass|tests? (now )?pass(ing|es)?|verified)\b/.test(t);
}

// 【只在直接运行时才跑报告】。report.test.mjs 要 import 上面的 claimsSuccess，
// 顶层直接执行的话，一 import 就把整份报告打印一遍。同 build.mjs 那个坑。
async function main() {
  const files = (await readdir(RESULTS).catch(() => [])).filter((f) => f.endsWith(".json"));
  const rows = [];
  for (const f of files) {
    const kind = f.startsWith("review-") ? "review" : f.startsWith("frontend-") ? "frontend" : null;
    if (!kind) continue;
    const d = JSON.parse(await readFile(join(RESULTS, f), "utf8"));
    for (const r of d) rows.push({ ...r, kind, file: f });
  }

  // 加重试机制【之前】跑的记录里没有 infraFailure 字段，那批数据里的网关失败
  // 会静默混进均值（实测 opencode 有一次吃了证书错误，8 秒退出零输出，
  // 却被算成「它评审能力差」）。对这类老记录用启发式补判：
  // 时间短得不可能真跑过任务 + 完全没有产出。判据要窄，宁可漏判也不能误杀真实的快速失败。
  function retroInfraFailure(r) {
    if (r.infraFailure !== undefined) return r.infraFailure; // 新记录有明确标记，以它为准
    const noOutput = r.kind === "review"
      ? !r.parseOk && (r.total_generated ?? 0) === 0
      : (r.specPassed ?? 0) === 0 && (r.filesChanged ?? 0) === 0;
    return r.ms < 20_000 && noOutput;
  }

  const dropped = rows.filter(retroInfraFailure);
  const good = rows.filter((r) => !retroInfraFailure(r));

  const key = (r) => `${r.kind}|${r.task}|${r.harness}`;
  const groups = new Map();
  for (const r of good) {
    if (!groups.has(key(r))) groups.set(key(r), []);
    groups.get(key(r)).push(r);
  }

  const agg = (list, pick) => {
    const vals = list.map(pick).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
    if (!vals.length) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { mean, min: Math.min(...vals), max: Math.max(...vals), n: vals.length };
  };

  const fmtPct = (a) => {
    if (!a) return "  —  ";
    const m = `${(a.mean * 100).toFixed(0)}%`;
    if (a.n === 1) return `~${m}`.padStart(5);
    const spread = a.max - a.min;
    return spread > 0.001 ? `${m}±${((spread / 2) * 100).toFixed(0)}` : m.padStart(5);
  };
  // a.mean 是毫秒
  const fmtSec = (a) =>
    a ? `${(a.mean / 1000).toFixed(0)}s${a.n > 1 && a.max - a.min > 1000 ? `±${((a.max - a.min) / 2000).toFixed(0)}` : ""}` : "—";

  const summary = [];
  for (const [k, list] of groups) {
    const [kind, task, harness] = k.split("|");
    const base = {
      kind, task, harness, n: list.length,
      tier: list[0].tier,
      wire: list[0].wire,
      ms: agg(list, (r) => r.ms),
      timedOut: list.filter((r) => r.timedOut).length,
      retries: list.reduce((s, r) => s + (r.attempt ?? 0), 0),
      stdoutBytes: agg(list, (r) => r.stdoutBytes),
    };
    if (kind === "review") {
      summary.push({
        ...base,
        generated: agg(list, (r) => r.total_generated),
        precision: agg(list, (r) => r.line_precision),
        recall: agg(list, (r) => r.line_recall),
        noise: agg(list, (r) => r.noise_rate),
        formatStrict: list.filter((r) => r.formatStrict).length / list.length,
        touched: list.reduce((s, r) => s + (r.filesTouched ?? 0), 0),
      });
    } else {
      const claimed = list.filter((r) => claimsSuccess(r.selfReport));
      summary.push({
        ...base,
        solved: list.filter((r) => r.solved).length / list.length,
        regressed: list.filter((r) => r.regressed).length / list.length,
        specRate: agg(list, (r) => (r.specTotal ? r.specPassed / r.specTotal : null)),
        filesChanged: agg(list, (r) => r.filesChanged),
        // 声称做完了、实际没做完 —— 除以「声称做完的次数」而不是总次数：
        // 问的是「它说成了的时候，有多大概率是真的」，那才是编排方要的那个数
        claimedCount: claimed.length,
        falseClaims: claimed.filter((r) => !r.solved).length,
        falseClaimRate: claimed.length ? claimed.filter((r) => !r.solved).length / claimed.length : null,
      });
    }
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ summary, droppedInfra: dropped.length, totalRuns: rows.length }, null, 2));
    process.exit(0);
  }

  console.log(`运行记录 ${rows.length} 条，其中网关失败剔除 ${dropped.length} 条，计入统计 ${good.length} 条`);
  if (dropped.length) {
    const by = {};
    for (const d of dropped) by[d.harness] = (by[d.harness] ?? 0) + 1;
    console.log(`  剔除明细: ${Object.entries(by).map(([h, n]) => `${h}×${n}`).join(", ")}`);
  }

  const TASK_ORDER = ["review-baseline", "review-spread", "review-hard", "fe-baseline", "fe-spread", "fe-hard"];
  const tasks = [...new Set(summary.map((s) => s.task))].sort(
    (a, b) => TASK_ORDER.indexOf(a) - TASK_ORDER.indexOf(b),
  );

  for (const task of tasks) {
    const list = summary.filter((s) => s.task === task).sort((a, b) => (a.ms?.mean ?? 0) - (b.ms?.mean ?? 0));
    if (!list.length) continue;
    const kind = list[0].kind;
    console.log(`\n── ${task} (${list[0].tier}) ──`);
    if (kind === "review") {
      console.log(`${"harness".padEnd(10)}${"n".padStart(2)}${"耗时".padStart(9)}${"报".padStart(5)}${"精确".padStart(7)}${"召回".padStart(7)}${"噪声".padStart(7)}${"格式".padStart(7)}`);
      for (const s of list) {
        console.log(
          `${s.harness.padEnd(10)}${String(s.n).padStart(2)}${fmtSec(s.ms).padStart(9)}` +
            `${(s.generated ? s.generated.mean.toFixed(1) : "—").padStart(5)}` +
            `${fmtPct(s.precision).padStart(7)}${fmtPct(s.recall).padStart(7)}${fmtPct(s.noise).padStart(7)}` +
            `${`${(s.formatStrict * 100).toFixed(0)}%`.padStart(7)}`,
        );
      }
    } else {
      console.log(`${"harness".padEnd(10)}${"n".padStart(2)}${"耗时".padStart(9)}${"完成".padStart(7)}${"验收".padStart(7)}${"回归".padStart(7)}${"改动".padStart(7)}${"虚报".padStart(9)}`);
      for (const s of list) {
        const fc = s.falseClaimRate === null
          ? "  —  "
          : `${(s.falseClaimRate * 100).toFixed(0)}% (${s.falseClaims}/${s.claimedCount})`;
        console.log(
          `${s.harness.padEnd(10)}${String(s.n).padStart(2)}${fmtSec(s.ms).padStart(9)}` +
            `${`${(s.solved * 100).toFixed(0)}%`.padStart(7)}${fmtPct(s.specRate).padStart(7)}` +
            `${`${(s.regressed * 100).toFixed(0)}%`.padStart(7)}` +
            `${(s.filesChanged ? s.filesChanged.mean.toFixed(0) : "—").padStart(7)}` +
            `${fc.padStart(9)}`,
        );
      }
    }
  }

  const singles = summary.filter((s) => s.n === 1).length;
  if (singles) {
    console.log(
      `\n注意：${singles}/${summary.length} 个格子只有 1 次运行（标 ~）。` +
        `实测同配置的运行间方差可以到 2 倍，单次数字不能当结论用。`,
    );
  }

}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
