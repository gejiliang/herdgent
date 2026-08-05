#!/usr/bin/env node
// 跑前端题（真实 PR：给一个挂掉的测试，修到通过）。
//
//   node bench/tasks/frontend2/run.mjs --reps 1
//   node bench/tasks/frontend2/run.mjs --harness codex --task fe2-baseline
//
// 判分三层，【都要记】：
//   solved      —— 目标测试全过，事办成了
//   testsIntact —— 没动测试文件。改测试让它变绿不叫修好，那是作弊
//   filesChanged—— 改了几处。大改动不一定错，但和「只动该动的地方」能区分开

import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_IDS } from "../../adapters/index.mjs";
import { runOne, RUNS_DIR } from "../../lib/runner.mjs";
import { TASKS } from "./build.mjs";
import { runVueTest, testFilesUntouched } from "./lib/vp.mjs";
import { changedFiles } from "../constraint/score.mjs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 20 * 60 * 1000;

const PROMPT = [
  "Read TASK.md in the current directory and do what it asks.",
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
    await exec("sh", ["-c", `chmod -R u+w ${JSON.stringify(dir)} 2>/dev/null; rm -rf ${JSON.stringify(dir)}`]).catch(() => {});
  }
}

const answers = JSON.parse(await readFile(join(HERE, "answers.json"), "utf8"));
const taskIds = arg("task") ? arg("task").split(",") : TASKS.map((t) => t.id);
const harnesses = arg("harness") ? arg("harness").split(",") : HARNESS_IDS;
const reps = Number(arg("reps", "1"));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(HERE, "..", "..", "results", `frontend2-${stamp}.json`);
await mkdir(dirname(outFile), { recursive: true });

console.log(`frontend2: ${harnesses.length} harness × ${taskIds.length} 题 × ${reps} 次\n`);

const results = [];
for (const taskId of taskIds) {
  const a = answers[taskId];
  const fixture = join(HERE, "fixtures", taskId);
  console.log(`\n── ${taskId} (${a.tier}) #${a.pr} ${a.title.slice(0, 52)} ──`);

  for (const harness of harnesses) {
    for (let rep = 1; rep <= reps; rep++) {
      const work = join(RUNS_DIR, `fe2-${taskId}-${harness}-${rep}`);
      await scrub(work);
      await mkdir(dirname(work), { recursive: true });
      try {
        await exec("cp", ["-c", "-R", fixture, work]);
      } catch {
        await exec("cp", ["-R", fixture, work]);
      }

      process.stdout.write(`  ${harness.padEnd(9)} #${rep} … `);
      const r = await runOne({
        harness, prompt: PROMPT, cwd: work, timeoutMs: TIMEOUT_MS, tag: `fe2-${taskId}-${rep}`,
      });

      const tr = await runVueTest(work, a.runTests[0]);
      const touchedTests = await testFilesUntouched(fixture, work, a.tests);
      const changed = await changedFiles(fixture, work);
      // 【改了测试就不算修好】——把断言删了当然会绿，那不是修复
      const solved = tr.ranOk && tr.failed === 0 && tr.passed > 0 && touchedTests.length === 0;

      results.push({
        task: taskId, tier: a.tier, harness, wire: r.wire, rep, pr: a.pr,
        ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms,
        attempt: r.attempt ?? 0, infraFailure: r.infraFailure ?? false,
        tokens: r.tokens ?? null, stdoutBytes: r.stdoutBytes ?? null,
        solved, testsIntact: touchedTests.length === 0, touchedTests,
        testPassed: tr.passed, testFailed: tr.failed, testRanOk: tr.ranOk,
        filesChanged: changed.length, changed,
        selfReport: (r.text ?? "").slice(0, 4000),
        runDir: r.runDir,
      });

      console.log(
        `${String((r.ms / 1000).toFixed(0)).padStart(4)}s  ` +
          `测试 ${tr.passed}/${tr.passed + tr.failed}  改${String(changed.length).padStart(2)}处  ` +
          `${solved ? "完成" : "未完成"}` +
          `${touchedTests.length ? `  ⚠改了测试 ${touchedTests.length} 个` : ""}` +
          `${r.timedOut ? "  ⚠超时" : ""}${r.infraFailure ? "  ⚠网关失败·不计分" : ""}`,
      );
      await scrub(work);
      await writeFile(outFile, JSON.stringify(results, null, 2));
    }
  }
}

console.log(`\n结果 → ${outFile}`);
