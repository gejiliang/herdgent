#!/usr/bin/env node
// 判分器自测。用真实的 answers.json 喂已知输入，检查它给出的分是不是该给的分。
//
// 为什么非测不可：判分器错了不会崩，只会安静地给出错误的数字，
// 然后 90 次真实运行的结论全部建立在那些数字上。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreReview, parseFindings } from "./score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(await readFile(join(HERE, "answers.json"), "utf8"));

let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? `  ← ${detail}` : ""}`);
    fail++;
  }
};

// —— 用「难」那题，因为它 positive / negative 都够多 ——
const A = answers["review-hard"];
const asJson = (list) =>
  JSON.stringify(list.map((c) => ({
    path: c.path, from_line: c.from_line, to_line: c.to_line,
    category: c.category, note: c.note,
  })));

console.log("满分卷：把 positive 标注原样交上去");
{
  const r = scoreReview(asJson(A.positive), A);
  check("parseOk", r.parseOk);
  check(`召回 = 1`, r.line_recall === 1, `实际 ${r.line_recall}`);
  check(`精确率 = 1`, r.line_precision === 1, `实际 ${r.line_precision}`);
  check(`噪声 = 0`, r.noise_rate === 0, `实际 ${r.noise_rate}`);
}

console.log("\n全踩坑：把 negative 标注原样交上去");
{
  const r = scoreReview(asJson(A.negative), A);
  check(`噪声率 = 1`, r.noise_rate === 1, `实际 ${r.noise_rate}（命中 ${r.noise_matches}/${r.total_generated}）`);
  check(`召回 = 0`, r.line_recall === 0, `实际 ${r.line_recall}`);
}

console.log("\n啰嗦卷：同一条 positive 换 5 种说法各报一遍");
{
  const one = A.positive[0];
  const spam = Array.from({ length: 5 }, (_, i) => ({
    path: one.path, from_line: one.from_line, to_line: one.to_line,
    category: one.category, note: `说法 ${i}`,
  }));
  const r = scoreReview(JSON.stringify(spam), A);
  check("召回只记 1 条（按标注去重）", r.unique_positive_hit === 1, `实际 ${r.unique_positive_hit}`);
  check("精确率仍是 1（5 条都确实命中了）", r.line_precision === 1, `实际 ${r.line_precision}`);
  check(
    `召回 = 1/${A.positive.length}`,
    Math.abs(r.line_recall - 1 / A.positive.length) < 1e-9,
    `实际 ${r.line_recall}`,
  );
}

console.log("\n瞎报：位置完全不存在的文件");
{
  const r = scoreReview(
    JSON.stringify([{ path: "no/such/file.go", from_line: 1, to_line: 2, note: "x" }]),
    A,
  );
  check("不算命中", r.line_matches === 0);
  check("也不算噪声（噪声特指命中了 negative 标注）", r.noise_matches === 0);
  check("计入 unmatched", r.unmatched === 1, `实际 ${r.unmatched}`);
  check("精确率 = 0", r.line_precision === 0, `实际 ${r.line_precision}`);
}

console.log("\n空卷与坏卷");
{
  const empty = scoreReview("[]", A);
  check("空数组：parseOk", empty.parseOk);
  check("空数组：精确率为 null 而不是 0", empty.line_precision === null, `实际 ${empty.line_precision}`);
  check("空数组：召回 = 0", empty.line_recall === 0, `实际 ${empty.line_recall}`);

  const junk = scoreReview("我觉得这个 PR 挺好的，没什么问题。", A);
  check("纯散文：parseOk = false", junk.parseOk === false);
  check("纯散文：不给分", junk.line_matches === 0 && junk.total_generated === 0);
}

console.log("\n输出包装：内容照收，但格式是否合约要分开记");
{
  const body = asJson(A.positive.slice(0, 2));

  const bare = parseFindings(body);
  check("裸数组：解析出 2 条", bare.findings.length === 2);
  check("裸数组：formatStrict = true", bare.strict === true);

  const fenced = parseFindings("```json\n" + body + "\n```");
  check("markdown fence：解析出 2 条", fenced.findings.length === 2);
  check("markdown fence：formatStrict = false", fenced.strict === false);

  const prose = parseFindings("Here you go:\n" + body + "\nHope this helps.");
  check("前后夹带散文：解析出 2 条", prose.findings.length === 2);
  check("前后夹带散文：formatStrict = false", prose.strict === false);

  // 实测 pi 的输出形态：一句话 + 逗号分隔的裸对象，没有外层方括号
  const naked = parseFindings(
    "Based on my review of the code, here are the findings:\n\n" +
      A.positive.slice(0, 3).map((c) => JSON.stringify({
        path: c.path, from_line: c.from_line, to_line: c.to_line, category: c.category, note: c.note,
      })).join(", "),
  );
  check("裸对象串（pi 实测形态）：解析出 3 条", naked.findings.length === 3, `实际 ${naked.findings.length}`);
  check("裸对象串：formatStrict = false", naked.strict === false);
  check("裸对象串：内容照样能拿满分", scoreReview(
    "Findings:\n" + A.positive.map((c) => JSON.stringify({
      path: c.path, from_line: c.from_line, to_line: c.to_line, category: c.category, note: c.note,
    })).join(", "), A).line_recall === 1);

  check("字段别名 line/file/comment", parseFindings(
    JSON.stringify([{ file: "a.go", line: 10, comment: "x" }]),
  ).findings.length === 1);
}

console.log("\n跨题不串味：拿基线题的答案去评难题");
{
  const r = scoreReview(asJson(answers["review-baseline"].positive), A);
  check("命中数 = 0", r.line_matches === 0, `实际 ${r.line_matches}`);
}

console.log(fail === 0 ? "\n判分器自测全过。" : `\n判分器自测 ${fail} 项未通过。`);
process.exit(fail ? 1 : 0);
