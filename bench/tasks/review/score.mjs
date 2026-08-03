// 评审任务判分。【主指标零 LLM】：只比对文件路径与行号区间。
//
// 指标定义（沿用 AACR-Bench 的口径，但只取其中不需要语义比对的那半）：
//   line_precision = 命中 positive 的意见数 / 模型输出的意见总数   —— 报得准不准
//   line_recall    = 被命中的 positive 条数 / positive 总数        —— 该报的报了多少
//   noise_rate     = 命中 negative 的意见数 / 模型输出的意见总数   —— 乱喷多不多
//
// 两条判分纪律：
//
// 1.【召回按标注去重，精确率不去重】。一条模型意见命中一条标注算一次命中；
//    但多条模型意见轰同一处，召回只记 1 —— 否则「把同一个问题换五种说法各报一遍」
//    就能刷高召回，那是在奖励啰嗦。
//
// 2.【解析不出 JSON 记作 0 条，不是判分失败】。输出格式是任务的一部分：
//    prompt 里写死了「只打印一个 JSON 数组」，做不到就是没完成任务。
//    悄悄容错等于把「不守输出契约」这个真实差异抹掉。

import { overlaps, samePath } from "./lib/diff.mjs";

/** 切出文本里所有顶层 JSON 对象，不管是数组元素、换行分隔还是空格分隔。 */
function looseObjects(s) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(s.slice(start, i + 1))); } catch { /* 半截对象跳过 */ }
        start = -1;
      } else if (depth < 0) depth = 0;
    }
  }
  return out;
}

const normalize = (v) =>
  v.filter((x) => x && typeof x === "object")
    .map((x) => ({
      path: String(x.path ?? x.file ?? x.filename ?? ""),
      from_line: Number(x.from_line ?? x.line ?? x.start_line ?? 0),
      to_line: Number(x.to_line ?? x.end_line ?? x.from_line ?? x.line ?? 0),
      category: String(x.category ?? ""),
      note: String(x.note ?? x.comment ?? x.message ?? ""),
    }))
    .filter((x) => x.path && x.from_line > 0);

/**
 * 从 harness 的输出里抠出评审意见。
 *
 * 返回两个不同的东西，【别把它们混成一个】：
 *   findings —— 宽松解析的结果，用来算能力分
 *   strict   —— 输出是否严格符合契约（整段就是一个 JSON 数组，没有别的话）
 *
 * 为什么要分开（实测逼出来的）：pi 输出了完全正确的内容，但没有外层方括号 ——
 * 逗号分隔的裸对象，前面还垫了一句「Based on my review…」。
 * 只用严格解析，它明明找出了真问题却得 0 分，那是在惩罚跟评审能力无关的东西；
 * 只用宽松解析，「守不守输出契约」这个真实差异又被抹平了。
 * 对编排来说后者恰恰要紧 —— herdgent 得解析 worker 的输出。所以两个都记。
 */
export function parseFindings(text) {
  if (!text || !text.trim()) {
    return { findings: [], parseOk: false, strict: false, reason: "empty output" };
  }
  const t = text.trim();

  // 严格：整段就是一个 JSON 数组
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return { findings: normalize(v), parseOk: true, strict: true, reason: null };
  } catch { /* 往下退 */ }

  // 宽松一：markdown fence 里是数组（内容对，只是裹了个围栏）
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try {
      const v = JSON.parse(fence[1].trim());
      if (Array.isArray(v)) return { findings: normalize(v), parseOk: true, strict: false, reason: "wrapped in markdown fence" };
    } catch { /* 往下退 */ }
  }

  // 宽松二：夹在散文里的 [...]
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a >= 0 && b > a) {
    try {
      const v = JSON.parse(t.slice(a, b + 1));
      if (Array.isArray(v)) return { findings: normalize(v), parseOk: true, strict: false, reason: "array embedded in prose" };
    } catch { /* 往下退 */ }
  }

  // 宽松三：根本没有数组，只有一串对象
  const objs = looseObjects(t);
  const findings = normalize(objs);
  if (findings.length) {
    return { findings, parseOk: true, strict: false, reason: "bare objects, no enclosing array" };
  }
  return { findings: [], parseOk: false, strict: false, reason: "no findings could be parsed" };
}

/** 该 finding 能对上的全部标注下标 */
function candidates(finding, annotations) {
  const out = [];
  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i];
    if (
      samePath(ann.path, finding.path) &&
      overlaps(ann.from_line, ann.to_line, finding.from_line, finding.to_line)
    ) {
      out.push(i);
    }
  }
  return out;
}

/**
 * 一对一贪心配对：一条模型意见最多【消耗】一条尚未被认领的标注。
 *
 * 为什么不能直接取第一个匹配项（踩过）：ground truth 里存在位置重叠的标注 ——
 * waveterm#1998 就有两条落在同一文件的重叠行区间。取第一个的话，前一条标注
 * 会把两次匹配都吃掉，后一条永远无人认领，于是【把标准答案原样交上去也只有 12/14 召回】。
 *
 * 优先认领没被占过的；都被占了就退回任意一个匹配项 —— 那仍是一次「报对了位置」
 * （计入精确率），只是不再增加召回，正好把「同一处换五种说法重复报」挡在召回之外。
 */
function claim(finding, annotations, used) {
  const cands = candidates(finding, annotations);
  if (!cands.length) return { index: -1, fresh: false };
  const fresh = cands.find((i) => !used.has(i));
  if (fresh !== undefined) return { index: fresh, fresh: true };
  return { index: cands[0], fresh: false };
}

/**
 * @param text  harness 的原始输出
 * @param answer answers.json 里该题的条目 {positive, negative}
 */
export function scoreReview(text, answer) {
  const { findings, parseOk, strict, reason } = parseFindings(text);
  const pos = answer.positive ?? [];
  const neg = answer.negative ?? [];

  const usedPos = new Set(); // 已被认领的 positive 标注下标 → 召回的分子
  const usedNeg = new Set();
  let posHits = 0;           // 命中次数，不去重 → 精确率的分子
  let negHits = 0;
  const perFinding = [];

  for (const f of findings) {
    const p = claim(f, pos, usedPos);
    const n = p.index >= 0 ? { index: -1, fresh: false } : claim(f, neg, usedNeg);
    if (p.index >= 0) {
      posHits++;
      if (p.fresh) usedPos.add(p.index);
    } else if (n.index >= 0) {
      negHits++;
      if (n.fresh) usedNeg.add(n.index);
    }
    perFinding.push({
      path: f.path, from_line: f.from_line, to_line: f.to_line,
      verdict: p.index >= 0 ? "positive" : n.index >= 0 ? "noise" : "unmatched",
      matchedIndex: p.index >= 0 ? p.index : n.index >= 0 ? n.index : null,
    });
  }
  const matchedPos = usedPos;

  const total = findings.length;
  return {
    parseOk,
    // 【单独成指标】：内容能不能解析（parseOk）与守不守输出契约（formatStrict）是两回事。
    // 合并的话，「找得准但格式松」和「格式对但什么也没找到」会被压成同一个数。
    formatStrict: strict,
    parseFailReason: reason,
    total_generated: total,
    positive_expected: pos.length,
    line_matches: posHits,
    unique_positive_hit: matchedPos.size,
    noise_matches: negHits,
    // 一条都没输出时精确率无定义（0/0）——记 null，不要记 0，
    // 否则「什么都不说」会和「说了但全错」在均值里混成一样。
    line_precision: total ? posHits / total : null,
    line_recall: pos.length ? matchedPos.size / pos.length : null,
    noise_rate: total ? negHits / total : null,
    unmatched: total - posHits - negHits,
    perFinding,
  };
}
