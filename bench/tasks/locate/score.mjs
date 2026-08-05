// 定位判分：它指的地方对不对。
//
// 【分两档记，不要只看行号】：
//   文件命中 —— 找对了文件。这是主指标，稳、不受「答案区间画多大」影响
//   行号命中 —— 行区间与 ground truth 重叠。更严，但也更受表述方式影响
//
// 为什么文件命中当主指标：同一段逻辑，有人答 20 行的函数体、有人答 3 行的关键语句，
// 两者都算找对了地方。行号只当精度的补充，不该主导排名。

import { overlaps, samePath } from "../review/lib/diff.mjs";

export function parseLocations(text) {
  if (!text || !text.trim()) return { locations: [], parseOk: false, strict: false };
  const t = text.trim();

  const norm = (v) =>
    v.filter((x) => x && typeof x === "object")
      .map((x) => ({
        path: String(x.path ?? x.file ?? x.filename ?? ""),
        from_line: Number(x.from_line ?? x.line ?? x.start_line ?? 0),
        to_line: Number(x.to_line ?? x.end_line ?? x.from_line ?? x.line ?? 0),
        why: String(x.why ?? x.reason ?? x.note ?? ""),
      }))
      .filter((x) => x.path);

  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return { locations: norm(v), parseOk: true, strict: true };
  } catch { /* 往下退 */ }

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try {
      const v = JSON.parse(fence[1].trim());
      if (Array.isArray(v)) return { locations: norm(v), parseOk: true, strict: false };
    } catch { /* 往下退 */ }
  }
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a >= 0 && b > a) {
    try {
      const v = JSON.parse(t.slice(a, b + 1));
      if (Array.isArray(v)) return { locations: norm(v), parseOk: true, strict: false };
    } catch { /* 往下退 */ }
  }
  // 一串裸对象（第一轮实测 pi 就是这个形态）
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
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
        try { objs.push(JSON.parse(t.slice(start, i + 1))); } catch { /* 半截跳过 */ }
        start = -1;
      } else if (depth < 0) depth = 0;
    }
  }
  const locations = norm(objs);
  return { locations, parseOk: locations.length > 0, strict: false };
}

export function scoreLocate(text, answer) {
  const { locations, parseOk, strict } = parseLocations(text);
  const spots = answer.spots ?? [];
  const truthFiles = [...new Set(spots.map((s) => s.path))];

  const fileHits = new Set();
  const lineHits = new Set();
  let fileCorrect = 0;

  for (const loc of locations) {
    const f = truthFiles.find((tf) => samePath(tf, loc.path));
    if (!f) continue;
    fileCorrect++;
    fileHits.add(f);
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      if (samePath(s.path, loc.path) && overlaps(s.from_line, s.to_line, loc.from_line, loc.to_line)) {
        lineHits.add(i);
      }
    }
  }

  const total = locations.length;
  return {
    parseOk, formatStrict: strict,
    total_reported: total,
    truth_files: truthFiles.length,
    // 主指标：ground truth 的文件，找到了几个
    file_recall: truthFiles.length ? fileHits.size / truthFiles.length : null,
    // 报出来的位置里，有多少指对了文件 —— 乱指一通会把它拉低
    file_precision: total ? fileCorrect / total : null,
    // 精度补充：行区间也对上了几处
    line_recall: spots.length ? lineHits.size / spots.length : null,
    hitFiles: [...fileHits],
    missedFiles: truthFiles.filter((f) => !fileHits.has(f)),
  };
}
