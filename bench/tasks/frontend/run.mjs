#!/usr/bin/env node
// 跑前端任务：harness × 题目 × 重复次数，用隐藏测试判分。
//
//   node bench/tasks/frontend/run.mjs
//   node bench/tasks/frontend/run.mjs --harness codex --task fe-baseline --reps 1
//
// 判分分两层，【都要记】：
//   spec  —— 该题的验收测试，衡量「做没做到」
//   smoke —— 基础功能测试，衡量「有没有把原来好的搞坏」
// 只看前者的话，「功能做出来了但把删除逻辑改崩了」会被记成满分。

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_IDS } from "../../adapters/index.mjs";
import { runOne, RUNS_DIR } from "../../lib/runner.mjs";
import { runSpecs } from "./lib/vitest.mjs";
import { TASKS } from "./build.mjs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 20 * 60 * 1000;

const PROMPT = [
  "You are working in a small React + Vite application.",
  "Read TASK.md in the current directory and implement what it asks for.",
  "",
  "The dependencies are already installed — do not run npm install, and do not add new dependencies.",
  "You can run the existing test suite with `npm test`.",
  "",
  "When you are done, briefly state what you changed and how you verified it.",
].join("\n");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function scrub(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    await exec("sh", ["-c",
      `chmod -R u+w ${JSON.stringify(dir)} 2>/dev/null; rm -rf ${JSON.stringify(dir)}`]).catch(() => {});
  }
}

const taskIds = arg("task") ? arg("task").split(",") : TASKS.map((t) => t.id);
const harnesses = arg("harness") ? arg("harness").split(",") : HARNESS_IDS;
const reps = Number(arg("reps", "3"));

const bad = harnesses.filter((h) => !HARNESS_IDS.includes(h));
if (bad.length) {
  console.error(`unknown harness: ${bad.join(", ")}`);
  process.exit(64);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(HERE, "..", "..", "results", `frontend-${stamp}.json`);
await mkdir(dirname(outFile), { recursive: true });

console.log(
  `frontend: ${harnesses.length} harness × ${taskIds.length} 题 × ${reps} 次 = ` +
    `${harnesses.length * taskIds.length * reps} 次运行，超时 ${TIMEOUT_MS / 60000} 分钟/次\n`,
);

const results = [];
for (const taskId of taskIds) {
  const t = TASKS.find((x) => x.id === taskId);
  if (!t) { console.error(`unknown task: ${taskId}`); process.exit(64); }
  const fixture = join(HERE, "fixtures", taskId);
  console.log(`\n── ${taskId} (${t.tier}) ──`);

  for (const harness of harnesses) {
    for (let rep = 1; rep <= reps; rep++) {
      const work = join(RUNS_DIR, `fe-${taskId}-${harness}-${rep}`);
      await scrub(work);
      await mkdir(dirname(work), { recursive: true });
      try {
        await exec("cp", ["-c", "-R", fixture, work]);
      } catch {
        await exec("cp", ["-R", fixture, work]);
      }

      process.stdout.write(`  ${harness.padEnd(9)} #${rep} … `);
      const r = await runOne({
        harness, prompt: PROMPT, cwd: work, timeoutMs: TIMEOUT_MS,
        tag: `fe-${taskId}-${rep}`,
      });

      const spec = await runSpecs(work, [join(HERE, "specs", t.spec)]);
      const smoke = await runSpecs(work, [join(HERE, "specs", "smoke.test.jsx")]);

      // 改了多少 —— 大改动不一定错，但和「只动该动的地方」是能区分开的信号
      let changed = 0;
      try {
        const { stdout } = await exec("sh", ["-c",
          `diff -rq --exclude=node_modules --exclude=__bench__ ${JSON.stringify(fixture)} ${JSON.stringify(work)} 2>/dev/null | wc -l`]);
        changed = Number(stdout.trim()) || 0;
      } catch { /* 比不出来记 0 */ }

      const solved = spec.ranOk && spec.failed === 0;
      const regressed = !smoke.ranOk || smoke.failed > 0;
      results.push({
        task: taskId, tier: t.tier, harness, wire: r.wire, rep,
        ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms,
        // 统计时先按 infraFailure 过滤，见 review/run.mjs 同处注释
        attempt: r.attempt ?? 0, infraFailure: r.infraFailure ?? false,
        usage: r.usage ?? null, stdoutBytes: r.stdoutBytes ?? null,
        solved, regressed,
        specPassed: spec.passed, specFailed: spec.failed, specTotal: spec.total,
        specRanOk: spec.ranOk, specFailedNames: spec.failedNames ?? [],
        smokePassed: smoke.passed, smokeFailed: smoke.failed, smokeTotal: smoke.total,
        filesChanged: changed,
        selfReport: (r.text ?? "").slice(0, 4000),
        runDir: r.runDir,
      });

      console.log(
        `${String((r.ms / 1000).toFixed(0)).padStart(4)}s  ` +
          `验收 ${spec.passed}/${spec.total}  基础 ${smoke.passed}/${smoke.total}  ` +
          `动了${String(changed).padStart(2)}处  ` +
          `${solved ? "完成" : "未完成"}${regressed ? "  ⚠有回归" : ""}${r.timedOut ? "  ⚠超时" : ""}` +
          `${r.attempt ? `  (重试${r.attempt}次)` : ""}${r.infraFailure ? "  ⚠网关失败·不计分" : ""}`,
      );
      await scrub(work);
      await writeFile(outFile, JSON.stringify(results, null, 2));
    }
  }
}

console.log(`\n结果 → ${outFile}`);
