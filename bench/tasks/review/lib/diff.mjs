// 解析 unified diff，拿到「每个文件在改动后那一侧，哪些行是这个 PR 碰过的」。
//
// 判分要靠它：标注的 from_line/to_line 是 side="right" 的坐标，
// 必须能落回 diff 的新增侧，否则 ground truth 和题面根本不在同一套坐标系上。

/**
 * 返回每个文件在新侧的两种行区间：
 *   hunk  —— hunk 头声明的整段范围，含未改动的上下文行
 *   added —— 只有真正的 + 行
 *
 * 【判分用 hunk，不用 added】。这不是宽松，是语义正确：GitHub 上的行评论可以打在
 * diff 的任何一行，包括上下文行。实测 waveterm#1998 有一条标注为 "Diff Level" 的
 * 意见落在 313 行，而 313 是 hunk 里的上下文行（最后一个 + 行是 312）——
 * 用 added 判就会把这条真标注误判成「对不上」，进而在判分时永远无法被命中。
 *
 * @returns Map<path, {hunk: Array<{start,end}>, added: Array<{start,end}>}>
 */
export function parseDiffRanges(diffText) {
  const out = new Map();
  let path = null;
  let newLine = 0;
  let cur = null;

  const bucket = () => {
    if (!out.has(path)) out.set(path, { hunk: [], added: [] });
    return out.get(path);
  };
  const flushAdded = () => {
    if (path && cur) {
      bucket().added.push(cur);
      cur = null;
    }
  };

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushAdded();
      path = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      flushAdded();
      const p = line.slice(4).trim();
      // /dev/null 表示文件被删了，右侧没有坐标可言
      path = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("@@")) {
      flushAdded();
      // @@ -a,b +c,d @@ ；d 省略时按 1 行算
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m && path) {
        newLine = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        if (count > 0) bucket().hunk.push({ start: newLine, end: newLine + count - 1 });
      }
      continue;
    }
    if (!path) continue;

    if (line.startsWith("+")) {
      if (cur && cur.end === newLine - 1) cur.end = newLine;
      else {
        flushAdded();
        cur = { start: newLine, end: newLine };
      }
      newLine++;
    } else if (line.startsWith("-")) {
      // 删除行不占新侧坐标
    } else if (line.startsWith(" ") || line === "") {
      flushAdded();
      newLine++;
    }
  }
  flushAdded();
  return out;
}

/** 两个闭区间是否重叠 */
export function overlaps(a1, a2, b1, b2) {
  const [lo1, hi1] = a1 <= a2 ? [a1, a2] : [a2, a1];
  const [lo2, hi2] = b1 <= b2 ? [b1, b2] : [b2, b1];
  return lo1 <= hi2 && lo2 <= hi1;
}

/**
 * 路径归一：模型可能报绝对路径、带 repo/ 前缀、或 ./ 开头。
 * 判分不该因为这种表面差异就判错，但也不能宽到把不同文件混为一谈 ——
 * 所以只做后缀匹配，且要求匹配到完整的路径段。
 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/^repo\//, "");
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const longer = x.length >= y.length ? x : y;
  const shorter = x.length >= y.length ? y : x;
  return longer.endsWith("/" + shorter);
}
