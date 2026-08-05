#!/usr/bin/env node
// 跑约束遵守题。
//
//   node bench/tasks/constraint/run.mjs --reps 1
//   node bench/tasks/constraint/run.mjs --harness codex --task con-readonly
//
// 【权限全开，靠禁令测】。拦住了就测不出「它想不想越界」——
// 那测的是沙箱强度，不是指令遵守。

import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_IDS } from "../../adapters/index.mjs";
import { runOne, RUNS_DIR } from "../../lib/runner.mjs";
import { TASKS } from "./build.mjs";
import { changedFiles, scoreConstraint } from "./score.mjs";
import { runVueTest } from "../frontend2/lib/vp.mjs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 15 * 60 * 1000;

// 只有「限定单文件」那道题需要看事办成没有；两道只读题的正确答案可能就是「不做」
const TEST_OF = { "con-scoped": "packages/runtime-core/__tests__/scheduler.spec.ts" };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function scrub(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    await exec("sh", ["-c", `chmod -R u+w ${JSON.stringify(dir)} 2>/dev/null; rm -rf ${JSON.stringify(dir)}`]).catch(() => {});
  }
}

const answers = JSON.parse(await readFile(join(HERE, "answers.json"), "utf8"));
const taskIds = arg("task") ? arg("task").split(",") : TASKS.map((t) => t.id);
const harnesses = arg("harness") ? arg("harness").split(",") : HARNESS_IDS;
const reps = Number(arg("reps", "1"));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(HERE, "..", "..", "results", `constraint-${stamp}.json`);
await mkdir(dirname(outFile), { recursive: true });

console.log(`constraint: ${harnesses.length} harness × ${taskIds.length} 题 × ${reps} 次\n`);

const results = [];
for (const taskId of taskIds) {
  const t = TASKS.find((x) => x.id === taskId);
  const a = answers[taskId];
  const fixture = join(HERE, "fixtures", taskId);
  console.log(`\n── ${taskId} (${a.tier}) 可写: ${a.allowWrite.length ? a.allowWrite.join(", ") : "无（只读）"} ──`);

  for (const harness of harnesses) {
    for (let rep = 1; rep <= reps; rep++) {
      const work = join(RUNS_DIR, `con-${taskId}-${harness}-${rep}`);
      await scrub(work);
      await mkdir(dirname(work), { recursive: true });
      try {
        await exec("cp", ["-c", "-R", fixture, work]);
      } catch {
        await exec("cp", ["-R", fixture, work]);
      }

      process.stdout.write(`  ${harness.padEnd(9)} #${rep} … `);
      const r = await runOne({
        harness, prompt: t.prompt, cwd: work, timeoutMs: TIMEOUT_MS, tag: `con-${taskId}-${rep}`,
      });

      const changed = await changedFiles(fixture, work);
      let testResult = null;
      if (TEST_OF[taskId]) {
        const tr = await runVueTest(work, TEST_OF[taskId]);
        testResult = tr.ranOk ? { passed: tr.passed, failed: tr.failed } : null;
      }
      const s = scoreConstraint(a, changed, testResult);

      results.push({
        task: taskId, tier: a.tier, harness, wire: r.wire, rep,
        ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms,
        attempt: r.attempt ?? 0, infraFailure: r.infraFailure ?? false,
        tokens: r.tokens ?? null, stdoutBytes: r.stdoutBytes ?? null,
        ...s,
        selfReport: (r.text ?? "").slice(0, 4000),
        runDir: r.runDir,
      });

      console.log(
        `${String((r.ms / 1000).toFixed(0)).padStart(4)}s  ${s.outcome}` +
          `${s.violated ? `  ⚠越界: ${s.violations.slice(0, 3).join(", ")}` : ""}` +
          `${testResult ? `  测试 ${testResult.passed}/${testResult.passed + testResult.failed}` : ""}` +
          `${r.infraFailure ? "  ⚠网关失败·不计分" : ""}`,
      );
      await scrub(work);
      await writeFile(outFile, JSON.stringify(results, null, 2));
    }
  }
}

console.log(`\n结果 → ${outFile}`);
