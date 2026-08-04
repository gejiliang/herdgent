// 本地计量代理：五家的请求全部经过它，在同一个点上数 token。
//
// 【为什么不用网关账本】：newapi 的用量接口要 admin 凭证，API key 查全是 404，
// 而网关归 homelab 管，不能为了评测去动它。
//
// 【为什么不用各家自报】：口径根本对不上 —— 第一轮实测 codex 报 input 5,969,324
// （把 5,897,600 的缓存命中算进了总量），claude 报 146,856 且 cached 恒为 0，
// pi 全 0，opencode 和 kimi 干脆不报。拿这组数做比较是错的。
//
// 代理是唯一能让五家用同一把尺子的地方：同一段代码解析三种 wire 的 usage，
// 谁也没有自报的余地。顺带还能数清楚每次任务到底发了多少轮请求 ——
// 那是「上下文反复重发」的直接证据，各家自报里看不出来。

import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { appendFile } from "node:fs/promises";

const UPSTREAM = "newapi.gejiliang.com";

/**
 * 从一次响应里抠出 token 用量。三种 wire 的字段位置都不同：
 *   chat/completions → usage.{prompt_tokens, completion_tokens}
 *   responses        → usage.{input_tokens, output_tokens}
 *   messages         → usage.{input_tokens, output_tokens}
 * 缓存命中【单独记】，不并进 input —— 那正是各家自报口径打架的地方。
 */
export function extractUsage(body) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    // 流式响应：usage 在最后几个 SSE 事件里，从后往前找第一个带 usage 的
    const lines = body.split("\n").filter((l) => l.startsWith("data:"));
    for (let i = lines.length - 1; i >= 0; i--) {
      const payload = lines[i].slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload);
        const u = ev.usage ?? ev.response?.usage ?? ev.message?.usage;
        if (u) return normalizeUsage(u);
      } catch {
        /* 半截事件，继续往前 */
      }
    }
    return null;
  }
  const u = j.usage ?? j.response?.usage;
  return u ? normalizeUsage(u) : null;
}

function normalizeUsage(u) {
  const cachedIn =
    u.cached_tokens ??
    u.prompt_cache_hit_tokens ??
    u.cache_read_input_tokens ??
    u.input_tokens_details?.cached_tokens ??
    u.prompt_tokens_details?.cached_tokens ??
    0;
  const input = u.input_tokens ?? u.prompt_tokens ?? 0;
  const output = u.output_tokens ?? u.completion_tokens ?? 0;
  const reasoning =
    u.output_tokens_details?.reasoning_tokens ??
    u.completion_tokens_details?.reasoning_tokens ??
    0;
  return {
    // input 一律记【不含缓存命中】的净量，缓存另计 —— 两者混在一起就没法跨家比
    input: Math.max(0, input - cachedIn),
    cached: cachedIn,
    output,
    reasoning,
  };
}

/**
 * 起代理。返回 { port, stop, totals }。
 * @param logFile 每次请求一行 JSONL，事后可重新统计
 */
export async function startMeter({ apiKey, logFile, label = "" } = {}) {
  const totals = { requests: 0, input: 0, cached: 0, output: 0, reasoning: 0, unparsed: 0 };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reqBody = Buffer.concat(chunks);
      const headers = { ...req.headers, host: UPSTREAM };
      // 代理自己持有密钥，受测进程拿到的是一个假 key —— 少一处泄漏面
      if (apiKey) {
        if (headers.authorization) headers.authorization = `Bearer ${apiKey}`;
        if (headers["x-api-key"]) headers["x-api-key"] = apiKey;
      }
      delete headers["content-length"];
      if (reqBody.length) headers["content-length"] = String(reqBody.length);

      const up = httpsRequest(
        { hostname: UPSTREAM, port: 443, path: req.url, method: req.method, headers },
        (upRes) => {
          const out = [];
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.on("data", (c) => {
            out.push(c);
            res.write(c);
          });
          upRes.on("end", () => {
            res.end();
            totals.requests++;
            const u = extractUsage(Buffer.concat(out).toString("utf8"));
            if (u) {
              totals.input += u.input;
              totals.cached += u.cached;
              totals.output += u.output;
              totals.reasoning += u.reasoning;
            } else {
              totals.unparsed++;
            }
            if (logFile) {
              appendFile(
                logFile,
                JSON.stringify({ label, path: req.url, status: upRes.statusCode, ...(u ?? {}) }) + "\n",
              ).catch(() => {});
            }
          });
        },
      );
      up.on("error", () => {
        // 上游挂了要如实回 502，不能悄悄吞掉 —— 否则受测方看到的是「模型没话说」
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      if (reqBody.length) up.write(reqBody);
      up.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    totals,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
