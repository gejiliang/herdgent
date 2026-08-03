#!/usr/bin/env node
// Ground truth 健全性检查：每条标注是否真的指向题面里存在的位置。
//
// 【不验这一步，判分器会照样跑出数字，而数字没有意义】。
// AACR-Bench 的标注绑在特定 commit 上，一旦 diff 取偏（force-push、diverged、
// 文件被后续改名），行号就对不上，判分变成随机数——而且不会报错。
//
// 判定按标注自己的 context 分档，不能一刀切：
//   Diff Level  → 必须落在 hunk 覆盖的新侧范围内（含上下文行，GitHub 允许在那里评论）
//   File Level  → 文件要在快照里，行号不超过文件长度；它本来就可以指向未改动的既有代码
//   Repo Level  → 同上。这类意见针对的是跨文件的设计问题，不该要求落在 diff 里

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiffRanges, overlaps, samePath } from "./lib/diff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(await readFile(join(HERE, "answers.json"), "utf8"));

async function fileLineCount(root, p) {
  try {
    const t = await readFile(join(root, p), "utf8");
    return t.split("\n").length;
  } catch {
    return null;
  }
}

let broken = 0;
for (const [id, a] of Object.entries(answers)) {
  const fixDir = join(HERE, "fixtures", id);
  const diff = await readFile(join(fixDir, "pr.diff"), "utf8");
  const ranges = parseDiffRanges(diff);
  const repoRoot = join(fixDir, "repo");

  console.log(`\n${id}  (${a.repo}#${a.pr}, ${a.tier})   diff 覆盖 ${ranges.size} 个文件`);

  for (const kind of ["positive", "negative"]) {
    const list = a[kind] ?? [];
    if (!list.length) {
      console.log(`  ${kind.padEnd(9)} —— 无`);
      continue;
    }
    const byCtx = {};
    const bad = [];
    for (const c of list) {
      const ctx = c.context ?? "?";
      byCtx[ctx] ??= { ok: 0, n: 0 };
      byCtx[ctx].n++;

      let ok;
      if (ctx === "Diff Level") {
        const key = [...ranges.keys()].find((p) => samePath(p, c.path));
        ok = !!key && ranges.get(key).hunk.some((r) => overlaps(r.start, r.end, c.from_line, c.to_line));
      } else {
        const n = await fileLineCount(repoRoot, c.path);
        ok = n !== null && c.from_line <= n;
      }
      if (ok) byCtx[ctx].ok++;
      else bad.push(`[${ctx}] ${c.path}:${c.from_line}-${c.to_line}`);
    }
    const total = list.length;
    const hit = Object.values(byCtx).reduce((s, v) => s + v.ok, 0);
    const detail = Object.entries(byCtx).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(" · ");
    console.log(`  ${kind.padEnd(9)} ${hit}/${total} 可定位   (${detail})`);
    for (const b of bad.slice(0, 5)) console.log(`    对不上: ${b}`);
    if (bad.length > 5) console.log(`    …还有 ${bad.length - 5} 条`);
    if (kind === "positive") broken += bad.length;
  }
}

console.log(
  broken === 0
    ? "\n全部 positive 标注都能在题面里定位 —— ground truth 与题面同坐标系，可以判分。"
    : `\n⚠️ ${broken} 条 positive 标注定位不到。它们在判分时永远无法被命中，只会撑大召回率的分母 ——` +
        `要么换题，要么剔掉并在结论里记录剔了几条。`,
);
process.exit(broken === 0 ? 0 : 1);
