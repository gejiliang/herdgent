#!/usr/bin/env node
// 终态后的 transcript 可能比 agent 状态晚一点落盘；这条只测有界重试，绝不碰 herdr。
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-plan-output-"));
process.env.HERDGENT_HOME = home;
// 即使以后这条测试意外沿着依赖碰到 herdr，也只能连到不存在的 socket。
process.env.HERDR_SOCKET_PATH = join(home, "no-such-herdr.sock");

try {
  const { readPlanOutputWithRetry } = await import(`../bin/plan-output.mjs?t=${Date.now()}`);
  let reads = 0;
  const result = await readPlanOutputWithRetry(() => {
    reads += 1;
    if (reads < 3) {
      throw Object.assign(new Error("transcript has not appeared yet"), { code: "transcript_not_ready" });
    }
    return { assistant_turns: 1, text: "eventual worker result" };
  });
  check(
    "前两次读失败、第三次有产出时步骤可继续",
    result.ready === true && result.attempts === 3 && reads === 3 && result.output?.text === "eventual worker result",
    JSON.stringify({ ready: result.ready, attempts: result.attempts, reads }),
  );

  // 动态断言重试器确实接在 runPlan 的终态产出确认处，而不是只存在于一个孤立单测里。
  const server = readFileSync(resolve(import.meta.dirname, "../bin/mcp-server.mjs"), "utf8");
  check(
    "runPlan 在终态后使用重试器",
    /await\s+readPlanOutputWithRetry\(\s*\(\)\s*=>\s*readWorkerResult\(worker\.slug\)\s*\)/.test(server),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
