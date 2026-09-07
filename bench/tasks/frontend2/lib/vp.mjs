// 跑 vuejs/core 的测试并解析结果。
//
// 【必须用项目自带的 runner】：vue 现在用 `vp`（@voidzero-dev/vite-plus-test）而不是
// 标准 vitest。`npx vitest` 会拿 npx 缓存里的那个版本，结果是
// 「Cannot find package 'jsdom'」—— 看起来像依赖坏了，其实是跑错了 runner。
//
// 【project 必须是 `unit*` 而不是 `unit`】：runtime-vapor 和 runtime-dom 被 unit
// 明确排除，只写 unit 会得到「No test files found」并退出码 1 ——
// 那看着像全挂，实际上一条都没跑。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);

const RE_FILES = /Test Files\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/;
const RE_TESTS = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/;

/**
 * @returns {passed, failed, total, ranOk, tail}
 */
export async function runVueTest(dir, testFile, { timeoutMs = 300_000 } = {}) {
  let out = "";
  try {
    const r = await exec(
      join(dir, "node_modules", ".bin", "vp"),
      ["test", "--project", "unit*", "--run", testFile],
      { cwd: dir, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    out = r.stdout + r.stderr;
  } catch (e) {
    // 有测试失败时退出码非 0，属正常情况
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  const m = RE_TESTS.exec(out);
  if (!m) {
    // 连汇总行都没有 —— 一条都没跑起来
    return { passed: 0, failed: 0, total: 0, ranOk: false, tail: out.slice(-1500) };
  }
  const failed = Number(m[1] ?? 0);
  const passed = Number(m[2] ?? 0);
  return { passed, failed, total: passed + failed, ranOk: true, tail: out.slice(-1500) };
}

/** 目标测试文件有没有被改过（题目明令禁止） */
export async function testFilesUntouched(fixtureDir, workDir, testFiles) {
  const changed = [];
  for (const f of testFiles) {
    try {
      await exec("cmp", ["-s", join(fixtureDir, f), join(workDir, f)]);
    } catch {
      changed.push(f);
    }
  }
  return changed;
}
