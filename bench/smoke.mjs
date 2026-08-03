#!/usr/bin/env node
// 冒烟：五个 harness 能不能各自挂上 deepseek-v4-flash 并说出一句话。
//
// 这是评测的【前置门】，不是评测本身。它只回答一个问题：接入通没通。
// 通不过就没有可比性可言 —— 别拿「跑不起来」当「效果差」。
//
//   node bench/smoke.mjs            # 全跑
//   node bench/smoke.mjs claude pi  # 只跑指定的

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_IDS } from "./adapters/index.mjs";
import { runOne, RUNS_DIR } from "./lib/runner.mjs";

const PROMPT =
  "Reply with exactly the single word PONG and nothing else. Do not use any tools.";
const TIMEOUT_MS = 240_000;

const want = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targets = want.length ? want : HARNESS_IDS;

const bad = targets.filter((t) => !HARNESS_IDS.includes(t));
if (bad.length) {
  console.error(`unknown harness: ${bad.join(", ")}\nknown: ${HARNESS_IDS.join(", ")}`);
  process.exit(64);
}

await mkdir(RUNS_DIR, { recursive: true });
const cwd = join(RUNS_DIR, "smoke-cwd");
await mkdir(cwd, { recursive: true });

console.log(`smoke: ${targets.join(", ")}  (model=deepseek-v4-flash, timeout=${TIMEOUT_MS / 1000}s)\n`);

const results = [];
// 【故意串行】。并行会让五家同时打网关，限流一触发就分不清「harness 有问题」
// 还是「被限流了」—— 冒烟阶段要的是干净的因果，不是速度。
for (const harness of targets) {
  process.stdout.write(`  ${harness.padEnd(9)} … `);
  const r = await runOne({ harness, prompt: PROMPT, cwd, timeoutMs: TIMEOUT_MS, tag: "smoke" });
  const said = (r.text ?? "").replace(/\s+/g, " ").trim();
  const pass = r.ok && /\bPONG\b/i.test(said);
  results.push({ ...r, pass, said });
  console.log(
    pass
      ? `PASS  ${(r.ms / 1000).toFixed(1)}s  «${said.slice(0, 60)}»`
      : `FAIL  ${(r.ms / 1000).toFixed(1)}s  exit=${r.exitCode}${r.timedOut ? " TIMEOUT" : ""}  «${said.slice(0, 80)}»`,
  );
}

const out = join(RUNS_DIR, "smoke-latest.json");
await writeFile(
  out,
  JSON.stringify(
    results.map((r) => ({
      harness: r.harness,
      wire: r.wire,
      pass: r.pass,
      ms: r.ms,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      said: r.said?.slice(0, 500),
      usage: r.usage,
      // 失败时留下 stderr 尾巴，否则排查只能重跑
      stderrTail: r.pass ? undefined : (r.stderr ?? "").slice(-2000),
    })),
    null,
    2,
  ),
);

const passed = results.filter((r) => r.pass).map((r) => r.harness);
const failed = results.filter((r) => !r.pass).map((r) => r.harness);
console.log(`\nPASS ${passed.length}/${results.length}: ${passed.join(", ") || "(none)"}`);
if (failed.length) console.log(`FAIL: ${failed.join(", ")}\ndetail → ${out}`);

process.exit(failed.length ? 1 : 0);
