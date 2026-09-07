#!/usr/bin/env node
// 第二道前置门：非交互模式下，每个 harness 能不能【真的读文件、真的写文件】。
//
// 为什么单独测这个：smoke.mjs 只证明了「模型能说话」。但 A 类以外的任务全都要动文件，
// 而各家的非交互入口对工具权限的处理完全不同 —— 实测 kimi 的 --prompt 拒绝一切权限
// 开关（--auto / --yolo 都报 "Cannot combine"），所以它到底允不允许工具调用是未知数。
//
// 【这道门失败不等于 harness 差】。它说明的是「这个入口不适合这类任务」，
// 要么换入口，要么把它排除在读写类任务之外并在结论里注明 —— 绝不能当成能力分。
//
//   node bench/tool-smoke.mjs [harness...]

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_IDS } from "./adapters/index.mjs";
import { runOne, RUNS_DIR } from "./lib/runner.mjs";

const INPUT = "hello bench";
const EXPECTED = "HELLO BENCH";
const PROMPT = [
  "In your current working directory there is a file named input.txt.",
  "Read it, convert its entire content to UPPERCASE,",
  "and write the result to a new file named output.txt in the same directory.",
  "Then reply with exactly: DONE",
].join(" ");
const TIMEOUT_MS = 300_000;

const want = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targets = want.length ? want : HARNESS_IDS;

const bad = targets.filter((t) => !HARNESS_IDS.includes(t));
if (bad.length) {
  console.error(`unknown harness: ${bad.join(", ")}`);
  process.exit(64);
}

console.log(`tool-smoke: ${targets.join(", ")}  (read+write, timeout=${TIMEOUT_MS / 1000}s)\n`);

const results = [];
for (const harness of targets) {
  // 【每家一个全新的工作目录】。共用一个的话，第二家会看到第一家写的 output.txt，
  // 直接答对 —— 测出来的是「谁跑在后面」，不是谁会用工具。
  const cwd = join(RUNS_DIR, `toolsmoke-cwd-${harness}`);
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "input.txt"), INPUT);

  process.stdout.write(`  ${harness.padEnd(9)} … `);
  const r = await runOne({ harness, prompt: PROMPT, cwd, timeoutMs: TIMEOUT_MS, tag: "toolsmoke" });

  const wrote = await readFile(join(cwd, "output.txt"), "utf8").catch(() => null);
  const pass = wrote !== null && wrote.trim() === EXPECTED;
  results.push({ harness, pass, ms: r.ms, exitCode: r.exitCode, wrote, said: (r.text ?? "").slice(0, 120), runDir: r.runDir });

  console.log(
    pass
      ? `PASS  ${(r.ms / 1000).toFixed(1)}s  output.txt=«${wrote.trim()}»`
      : `FAIL  ${(r.ms / 1000).toFixed(1)}s  exit=${r.exitCode}  output.txt=${
          wrote === null ? "(not created)" : `«${wrote.trim().slice(0, 40)}»`
        }  said=«${(r.text ?? "").replace(/\s+/g, " ").slice(0, 70)}»`,
  );
}

await writeFile(join(RUNS_DIR, "tool-smoke-latest.json"), JSON.stringify(results, null, 2));

const passed = results.filter((r) => r.pass).map((r) => r.harness);
const failed = results.filter((r) => !r.pass).map((r) => r.harness);
console.log(`\ncan use tools: ${passed.join(", ") || "(none)"}`);
if (failed.length) console.log(`cannot (or did not): ${failed.join(", ")}`);

process.exit(failed.length ? 1 : 0);
