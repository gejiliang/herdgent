#!/usr/bin/env node
// 回算传输量 / 答案量 / 放大倍数，补进已有的结果文件。
//
// 【为什么需要这个】：我一度把 stdout 字节数当成「这家输出啰嗦」的能力指标，
// pi 单次 62MB 直接写进了结论。拆开一看 99.9% 是协议重复 ——
// 它的 --mode json 每次增量重发整条消息快照而不是 delta。
// 真实内容只有 90KB，和其它家同一量级。
//
// 传输量受【输出模式】影响，不是能力特征；真正对编排有意义的是
// 「为了拿到这段答案，要处理多少字节」= 传输量 / 答案量。
// 那个比值对五家公平，因为分子分母都用同一套口径。
//
// 原始 stdout 都还在 runDir 里，所以不用重跑。

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

// 各类结果里「最终答案」存在哪个字段
const ANSWER_FIELD = ["rawText", "selfReport", "text"];

function answerOf(r) {
  for (const f of ANSWER_FIELD) {
    if (typeof r[f] === "string" && r[f].length) return r[f];
  }
  return "";
}

let patched = 0;
let files = 0;
for (const f of (await readdir(RESULTS).catch(() => []))) {
  if (!f.endsWith(".json") || f === "SUMMARY.json") continue;
  const path = join(RESULTS, f);
  let rows;
  try {
    rows = JSON.parse(await readFile(path, "utf8"));
  } catch {
    continue;
  }
  if (!Array.isArray(rows)) continue;

  let touched = false;
  for (const r of rows) {
    if (r.answerBytes != null) continue;

    // 传输量：优先用实测的 stdoutBytes，缺失时回落到磁盘上的 stdout.txt
    let bytes = r.stdoutBytes;
    if (bytes == null && r.runDir) {
      bytes = await stat(join(r.runDir, "stdout.txt")).then((s) => s.size).catch(() => null);
    }
    const ans = answerOf(r);
    // selfReport 在部分 runner 里截断到 4000，这种情况下答案量只是下界，标出来
    const truncated = ans.length >= 4000 && !r.rawText;
    r.answerBytes = Buffer.byteLength(ans, "utf8");
    r.answerBytesTruncated = truncated;
    r.stdoutBytes = bytes ?? null;
    r.amplification = bytes && r.answerBytes ? bytes / r.answerBytes : null;
    touched = true;
    patched++;
  }
  if (touched) {
    await writeFile(path, JSON.stringify(rows, null, 2));
    files++;
  }
}

console.log(`补了 ${patched} 条记录，涉及 ${files} 个结果文件`);
