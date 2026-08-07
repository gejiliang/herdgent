#!/usr/bin/env node
// 排除规则自测。
//
// 【为什么非测不可】：这个模块曾经把路径拼成 bench/bench/exclude.json，
// 读不到文件、catch 吞掉错误，于是规则一条都没生效 —— 而表面完全看不出来，
// 统计照跑、数字照出，只是 5 次配置造成的假失败混了进去。
// 静默失效比报错难查得多，所以「规则确实被加载了」本身要有断言。

import { excluded } from "./exclude.mjs";

let fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? `  ← ${detail}` : ""}`);
  if (!cond) fail++;
};

console.log("规则文件确实被加载了（不是静默回落到空规则）");
{
  // exclude.json 里那条：review-hard × claude × 超时 × 约 900 秒
  const r = await excluded({ task: "review-hard", harness: "claude", timedOut: true, ms: 900_000 });
  check("900 秒那批被排除", r !== null, "规则没加载或没匹配上");
  check("给出了原因", !!r?.reason && r.reason.length > 10);
}

console.log("\n边界：只差一点的不该被误伤");
{
  check("同题同家但没超时 → 保留", await excluded({ task: "review-hard", harness: "claude", timedOut: false, ms: 900_000 }) === null);
  check("超时但耗时差很远（1300s）→ 保留", await excluded({ task: "review-hard", harness: "claude", timedOut: true, ms: 1_300_000 }) === null);
  check("换一家 → 保留", await excluded({ task: "review-hard", harness: "codex", timedOut: true, ms: 900_000 }) === null);
  check("换一题 → 保留", await excluded({ task: "loc-hard", harness: "claude", timedOut: true, ms: 900_000 }) === null);
}

console.log("\n基础设施失败照样排除");
{
  check("infraFailure 标记", (await excluded({ task: "loc-hard", harness: "pi", infraFailure: true }))?.reason === "网关抖动");
  check("正常记录不排除", await excluded({ task: "loc-hard", harness: "pi", infraFailure: false, ms: 60_000 }) === null);
}

console.log("\n旧记录（没有 infraFailure 字段）的启发式补判");
{
  check("8 秒 + 零产出 → 排除", (await excluded({ task: "review-hard", harness: "opencode", ms: 8_000, parseOk: false })) !== null);
  check("8 秒但有产出 → 保留", await excluded({ task: "review-hard", harness: "opencode", ms: 8_000, parseOk: true, total_generated: 3 }) === null);
  check("耗时正常且零产出 → 保留（那是能力问题）", await excluded({ task: "review-hard", harness: "opencode", ms: 400_000, parseOk: false }) === null);
}

console.log(fail === 0 ? "\n排除规则自测全过。" : `\n${fail} 项未通过。`);
process.exit(fail ? 1 : 0);
