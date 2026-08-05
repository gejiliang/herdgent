#!/usr/bin/env node
// 跑定位题。
//
//   node bench/tasks/locate/run.mjs --reps 1
//   node bench/tasks/locate/run.mjs --harness codex --task loc-readonly
//
// 定位是【只读】任务：题面明说不要改文件。顺手记一下它有没有真的守住 ——
// 那是约束遵守的免费旁证，不额外花钱。

import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_IDS } from "../../adapters/index.mjs";
import { runOne, RUNS_DIR } from "../../lib/runner.mjs";
import { TASKS } from "./build.mjs";
import { scoreLocate } from "./score.mjs";
import { changedFiles } from "../constraint/score.mjs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 15 * 60 * 1000;

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
const outFile = join(HERE, "..", "..", "results", `locate-${stamp}.json`);
await mkdir(dirname(outFile), { recursive: true });

console.log(`constraint: ${harnesses.length} harness × ${taskIds.length} 题 × ${reps} 次\n`);

const results = [];
for (const taskId of taskIds) {
  const t = TASKS.find((x) => x.id === taskId);
  const promptText = `${t.question}\n\n${(await readFile(join(HERE, 'fixtures', taskId, 'TASK.md'), 'utf8')).split('\n').slice(-9).join('\n')}`;
  const a = answers[taskId];
  const fixture = join(HERE, "fixtures", taskId);
  console.log(`\n── ${taskId} (${a.tier}) ground truth: ${a.files.length} 文件 / ${a.spots.length} 处 ──`);

  for (const harness of harnesses) {
    for (let rep = 1; rep <= reps; rep++) {
      const work = join(RUNS_DIR, `loc-${taskId}-${harness}-${rep}`);
      await scrub(work);
      await mkdir(dirname(work), { recursive: true });
      try {
        await exec("cp", ["-c", "-R", fixture, work]);
      } catch {
        await exec("cp", ["-R", fixture, work]);
      }

      process.stdout.write(`  ${harness.padEnd(9)} #${rep} … `);
      const r = await runOne({
        harness, prompt: promptText, cwd: work, timeoutMs: TIMEOUT_MS, tag: `loc-${taskId}-${rep}`,
      });

      const changed = await changedFiles(fixture, work);
      const s = scoreLocate(r.text ?? "", a);

      results.push({
        task: taskId, tier: a.tier, harness, wire: r.wire, rep,
        ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms,
        attempt: r.attempt ?? 0, infraFailure: r.infraFailure ?? false,
        tokens: r.tokens ?? null, stdoutBytes: r.stdoutBytes ?? null,
        ...s,
        filesTouched: changed.length,
        rawText: r.text ?? "",
        runDir: r.runDir,
      });

      const pct = (v) => (v === null ? " n/a" : `${(v * 100).toFixed(0)}%`.padStart(4));
      console.log(
        `${String((r.ms / 1000).toFixed(0)).padStart(4)}s  ` +
          `报${String(s.total_reported).padStart(2)}处  ` +
          `文件召${pct(s.file_recall)} 准${pct(s.file_precision)}  行召${pct(s.line_recall)}  ` +
          `${s.formatStrict ? "格式✓" : s.parseOk ? "格式松" : "解析不出"}` +
          `${changed.length ? `  ⚠动了${changed.length}处文件` : ""}` +
          `${r.infraFailure ? "  ⚠网关失败·不计分" : ""}`,
      );
      await scrub(work);
      await writeFile(outFile, JSON.stringify(results, null, 2));
    }
  }
}

console.log(`\n结果 → ${outFile}`);
