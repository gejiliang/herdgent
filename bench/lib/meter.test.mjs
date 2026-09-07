#!/usr/bin/env node
// 计量代理的 usage 解析自测。
//
// 这是 token 指标唯一的来源，解析错了整个指标就是假的 ——
// 而且错得很安静：数字照样出来，只是不对。
// 三种 wire 的字段位置全不一样，缓存命中的字段名有五种写法，必须逐个钉住。

import { extractUsage } from "./meter.mjs";

let fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? `  ← ${detail}` : ""}`);
  if (!cond) fail++;
};

console.log("chat/completions（opencode / pi / kimi 走这条）");
{
  const u = extractUsage(JSON.stringify({
    usage: {
      prompt_tokens: 96, completion_tokens: 16, total_tokens: 112,
      prompt_cache_hit_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 14 },
    },
  }));
  check("input 扣掉缓存命中", u.input === 66, `实际 ${u?.input}`);
  check("缓存单独记", u.cached === 30, `实际 ${u?.cached}`);
  check("output", u.output === 16);
  check("reasoning", u.reasoning === 14);
}

console.log("\nresponses（codex 走这条）");
{
  const u = extractUsage(JSON.stringify({
    usage: {
      input_tokens: 568480, output_tokens: 19802,
      input_tokens_details: { cached_tokens: 548992 },
      output_tokens_details: { reasoning_tokens: 18085 },
    },
  }));
  check("input 净量 = 568480 - 548992", u.input === 19488, `实际 ${u?.input}`);
  check("缓存 548992", u.cached === 548992);
  check("reasoning 18085", u.reasoning === 18085);
}

console.log("\nmessages（claude 走这条）");
{
  const u = extractUsage(JSON.stringify({
    usage: { input_tokens: 89, output_tokens: 15, cache_read_input_tokens: 40 },
  }));
  check("input 净量 = 89 - 40", u.input === 49, `实际 ${u?.input}`);
  check("缓存 40", u.cached === 40);
}

console.log("\nAnthropic wire：thinking 在 content 块里，不在 usage");
{
  const u = extractUsage(JSON.stringify({
    content: [
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "x".repeat(4000) },
    ],
    usage: { input_tokens: 100, output_tokens: 1200 },
  }));
  check("从 content 估出 reasoning", u.reasoning === 1000, `实际 ${u?.reasoning}`);
  check("标记为估算值", u.reasoningEstimated === true);
  check("不影响 input/output", u.input === 100 && u.output === 1200);
}
{
  // usage 里已有精确值时不该被估算覆盖
  const u = extractUsage(JSON.stringify({
    content: [{ type: "thinking", thinking: "y".repeat(8000) }],
    usage: { input_tokens: 10, output_tokens: 50, output_tokens_details: { reasoning_tokens: 42 } },
  }));
  check("usage 里有精确值时以它为准", u.reasoning === 42, `实际 ${u?.reasoning}`);
  check("精确值不打估算标记", !u.reasoningEstimated);
}
{
  const u = extractUsage(JSON.stringify({
    content: [{ type: "text", text: "no thinking here" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
  check("没有 thinking 块时 reasoning 保持 0", u.reasoning === 0);
}

console.log("\n流式：usage 在最后几个 SSE 事件里");
{
  const sse = [
    'data: {"type":"content_block_delta","delta":{"text":"PO"}}',
    'data: {"type":"content_block_delta","delta":{"text":"NG"}}',
    'data: {"type":"message_delta","usage":{"input_tokens":100,"output_tokens":8}}',
    "data: [DONE]",
    "",
  ].join("\n");
  const u = extractUsage(sse);
  check("从 SSE 尾部捞到 usage", u !== null && u.output === 8, `实际 ${JSON.stringify(u)}`);
}

console.log("\n不该炸也不该瞎猜");
{
  check("没有 usage 字段 → null", extractUsage(JSON.stringify({ choices: [] })) === null);
  check("空响应 → null", extractUsage("") === null);
  check("非 JSON 垃圾 → null", extractUsage("<html>502 Bad Gateway</html>") === null);
  check("SSE 里没有 usage → null", extractUsage('data: {"a":1}\ndata: [DONE]\n') === null);
  const u = extractUsage(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  check("没有缓存字段时 cached = 0 而不是 undefined", u.cached === 0);
  check("没有缓存字段时 input 不被扣", u.input === 10);
}

console.log("\n边界：缓存数大于 input（上游口径异常）");
{
  const u = extractUsage(JSON.stringify({
    usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 150 },
  }));
  check("净 input 不为负", u.input === 0, `实际 ${u?.input}`);
}

console.log(fail === 0 ? "\n计量解析自测全过。" : `\n${fail} 项未通过。`);
process.exit(fail ? 1 : 0);
