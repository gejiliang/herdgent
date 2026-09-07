// 把隐藏测试注入某个 fixture 副本并跑，拿回结构化结果。
//
// 【注入而不是外挂】：vitest 的 root 在 app 目录，放在 app 外面的测试文件
// 会被 include 规则直接排除掉 —— 表现是「No test files found」并退出码 1，
// 看起来像测试全挂，其实一条都没跑。

import { cp, mkdir, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);
const INJECT_DIR = "__bench__";

/**
 * @param fixtureDir 被测的应用副本（agent 改过的那份）
 * @param specPaths  隐藏测试文件的绝对路径
 * @returns {passed, failed, total, ranOk, raw}
 */
export async function runSpecs(fixtureDir, specPaths, { timeoutMs = 180_000 } = {}) {
  const inject = join(fixtureDir, INJECT_DIR);
  await rm(inject, { recursive: true, force: true });
  await mkdir(inject, { recursive: true });
  for (const p of specPaths) {
    await cp(p, join(inject, p.split("/").pop()));
  }

  const reportFile = join(fixtureDir, ".vitest-report.json");
  let raw = "";
  try {
    const { stdout, stderr } = await exec(
      "npx",
      ["vitest", "run", "--root", ".", INJECT_DIR, "--reporter=json", "--outputFile", reportFile],
      { cwd: fixtureDir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    );
    raw = stdout + stderr;
  } catch (e) {
    // 有测试失败时 vitest 退出码非 0，这是正常情况，不是执行错误
    raw = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  let report = null;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch {
    /* 没生成报告 —— 下面按「没跑起来」处理 */
  }
  await rm(reportFile, { force: true });
  await rm(inject, { recursive: true, force: true });

  if (!report) {
    return { passed: 0, failed: 0, total: 0, ranOk: false, raw: raw.slice(-4000) };
  }

  const tests = (report.testResults ?? []).flatMap((f) => f.assertionResults ?? []);
  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  return {
    passed,
    failed,
    total: tests.length,
    ranOk: tests.length > 0,
    failedNames: tests.filter((t) => t.status === "failed").map((t) => t.title),
    raw: raw.slice(-4000),
  };
}
