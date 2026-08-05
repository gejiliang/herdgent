#!/usr/bin/env node
// 跑评审任务：harness × 题目 × 重复次数，判分后落盘。
//
//   node bench/tasks/review/run.mjs                        # 全跑（5 harness × 3 题 × 3 次）
//   node bench/tasks/review/run.mjs --harness pi --reps 1   # 只跑 pi，跑一遍
//   node bench/tasks/review/run.mjs --task review-baseline  # 只跑基线题
//
// 【故意串行】。耗时本身是要测的指标之一，并发会让五家互相抢网关配额、
// 把耗时差异搅成噪声。慢，但数字是干净的。

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_IDS } from "../../adapters/index.mjs";
import { runOne, RUNS_DIR } from "../../lib/runner.mjs";
import { reviewPrompt } from "./prompt.mjs";
import { scoreReview } from "./score.mjs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 15 * 60 * 1000;

// 工作副本里可能留下只读的依赖缓存（Go module cache 等），fs.rm 会 EACCES。
// 同 lib/runner.mjs 里的 hardRemove —— 先把写权限加回来。
async function scrub(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    await exec("sh", ["-c",
      `chmod -R u+w ${JSON.stringify(dir)} 2>/dev/null; rm -rf ${JSON.stringify(dir)}`]).catch(() => {});
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const answers = JSON.parse(await readFile(join(HERE, "answers.json"), "utf8"));
const taskIds = arg("task") ? arg("task").split(",") : Object.keys(answers);
const harnesses = arg("harness") ? arg("harness").split(",") : HARNESS_IDS;
const reps = Number(arg("reps", "3"));

const bad = harnesses.filter((h) => !HARNESS_IDS.includes(h));
if (bad.length) {
  console.error(`unknown harness: ${bad.join(", ")}`);
  process.exit(64);
}

const PROMPT = reviewPrompt();
// 【文件名必须带 harness 与 pid】（踩过）：五家并行时同秒启动，
// 光靠时间戳会撞名，后写的把先写的整个盖掉 —— 数据静默丢失，
// 而且从结果文件上完全看不出来少了东西。
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${harnesses.join("_")}-${process.pid}`;
const outFile = join(HERE, "..", "..", "results", `review-${stamp}.json`);
await mkdir(dirname(outFile), { recursive: true });

console.log(
  `review: ${harnesses.length} harness × ${taskIds.length} 题 × ${reps} 次 = ` +
    `${harnesses.length * taskIds.length * reps} 次运行，超时 ${TIMEOUT_MS / 60000} 分钟/次\n`,
);

const results = [];
for (const taskId of taskIds) {
  const answer = answers[taskId];
  const fixture = join(HERE, "fixtures", taskId);
  console.log(`\n── ${taskId} (${answer.repo}#${answer.pr}, ${answer.tier}) ` +
    `该报 ${answer.positive.length} · 诱饵 ${answer.negative.length} ──`);

  for (const harness of harnesses) {
    for (let rep = 1; rep <= reps; rep++) {
      // 【每次一份独立工作副本】。APFS clonefile 写时复制，63MB 也是零点几秒、
      // 不实际占空间；换来的是「agent 改了什么都不会污染下一次运行」。
      const work = join(RUNS_DIR, `review-${taskId}-${harness}-${rep}`);
      await scrub(work);
      await mkdir(dirname(work), { recursive: true });
      try {
        await exec("cp", ["-c", "-R", fixture, work]);
      } catch {
        await cp(fixture, work, { recursive: true }); // 非 APFS 时退回普通复制
      }

      process.stdout.write(`  ${harness.padEnd(9)} #${rep} … `);
      const r = await runOne({
        harness, prompt: PROMPT, cwd: work, timeoutMs: TIMEOUT_MS,
        tag: `review-${taskId}-${rep}`,
      });
      const s = scoreReview(r.text ?? "", answer);

      // 只读任务里它有没有动文件 —— 顺手记下来，这是约束遵守的信号
      let touched = 0;
      try {
        const { stdout } = await exec("sh", ["-c",
          `diff -rq ${JSON.stringify(fixture)} ${JSON.stringify(work)} 2>/dev/null | wc -l`]);
        touched = Number(stdout.trim()) || 0;
      } catch { /* 比不出来就记 0，不阻断 */ }

      results.push({
        task: taskId, tier: answer.tier, harness, wire: r.wire, rep,
        ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms,
        // 【统计时必须先按 infraFailure 过滤】：重试完还是网络失败的那次，
        // 记进能力分就是把一次网关抖动算成这家不行
        attempt: r.attempt ?? 0, infraFailure: r.infraFailure ?? false,
        stdoutBytes: r.stdoutBytes ?? null,
        usage: r.usage ?? null, filesTouched: touched,
        ...s,
        // 【不截断】。改了解析规则要能就地重判分，截断过的输出重判就是错的。
        // 完整 stdout 另有一份在 runDir/stdout.txt，这里存的是抽取出的最终回答。
        rawText: r.text ?? "",
        runDir: r.runDir,
      });

      const pct = (v) => (v === null ? " n/a" : `${(v * 100).toFixed(0)}%`.padStart(4));
      console.log(
        `${String((r.ms / 1000).toFixed(0)).padStart(4)}s  ` +
          `报${String(s.total_generated).padStart(2)}条  ` +
          `准${pct(s.line_precision)}  召${pct(s.line_recall)}  噪${pct(s.noise_rate)}  ` +
          `${s.formatStrict ? "格式✓" : s.parseOk ? "格式松" : "解析不出"}` +
          `${touched ? `  ⚠动了${touched}处文件` : ""}${r.timedOut ? "  ⚠超时" : ""}` +
          `${r.attempt ? `  (重试${r.attempt}次)` : ""}${r.infraFailure ? "  ⚠网关失败·不计分" : ""}`,
      );
      await scrub(work);
      await writeFile(outFile, JSON.stringify(results, null, 2));
    }
  }
}

console.log(`\n结果 → ${outFile}`);
