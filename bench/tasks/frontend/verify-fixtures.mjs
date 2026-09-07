#!/usr/bin/env node
// 题目自检：确认三道题在【未经改动的 fixture】上恰好是「没做」的状态。
//
// 两个方向都要验，缺一不可：
//   · 隐藏测试必须【失败】—— 全绿说明题目等于已经做完了，测不出任何东西
//   · 基础 smoke 必须【通过】—— 挂了说明 fixture 一开始就是坏的，
//     后面测出来的是 harness 在替我们修 fixture，不是在做题
//
// 难题是例外：它的 fixture 里【故意】埋了 bug，所以 smoke 里那条「删除后合计」
// 必须挂 —— 挂不了反而说明 bug 没注入成功。

import { rm, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSpecs } from "./lib/vitest.mjs";
import { TASKS } from "./build.mjs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, ".verify");

let fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? `  ← ${detail}` : ""}`);
  if (!cond) fail++;
};

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

for (const t of TASKS) {
  console.log(`\n${t.id} (${t.tier})`);
  const src = join(HERE, "fixtures", t.id);
  const dir = join(WORK, t.id);
  try {
    await exec("cp", ["-c", "-R", src, dir]);
  } catch {
    await exec("cp", ["-R", src, dir]);
  }

  // 1. 该题的隐藏测试：必须有失败项
  const spec = await runSpecs(dir, [join(HERE, "specs", t.spec)]);
  check(`隐藏测试跑起来了`, spec.ranOk, spec.raw?.slice(-300));
  check(
    `未改动时有失败项（${spec.passed} 过 / ${spec.failed} 挂 / 共 ${spec.total}）`,
    spec.failed > 0,
    "全绿意味着题目已经做完了，没有区分度",
  );

  // 2. 基础 smoke
  const smoke = await runSpecs(dir, [join(HERE, "specs", "smoke.test.jsx")]);
  if (t.id === "fe-hard") {
    check(
      `smoke 里「删除后合计」按预期挂掉（bug 已注入）`,
      smoke.failed === 1 && (smoke.failedNames ?? []).some((n) => /remove/i.test(n)),
      `实际 ${smoke.passed} 过 / ${smoke.failed} 挂：${(smoke.failedNames ?? []).join(", ")}`,
    );
  } else {
    check(
      `smoke 全绿（fixture 本身是好的，${smoke.passed}/${smoke.total}）`,
      smoke.ranOk && smoke.failed === 0,
      (smoke.failedNames ?? []).join(", ") || smoke.raw?.slice(-300),
    );
  }

  // 3. 隐藏测试没混进题面
  const { stdout } = await exec("sh", ["-c",
    `find ${JSON.stringify(dir)} -name '*.test.jsx' -not -path '*/node_modules/*' | wc -l`]);
  check(`题面里没有测试文件`, Number(stdout.trim()) === 0, `找到 ${stdout.trim()} 个`);

  await rm(dir, { recursive: true, force: true });
}

await rm(WORK, { recursive: true, force: true });
console.log(fail === 0 ? "\n三道题都处在「没做」的状态，可以开跑。" : `\n${fail} 项未通过 —— 题目还不能用。`);
process.exit(fail ? 1 : 0);
