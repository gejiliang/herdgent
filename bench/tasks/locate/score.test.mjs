#!/usr/bin/env node
// 定位判分自测。用真实的 answers.json 喂已知输入。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreLocate, parseLocations } from "./score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(await readFile(join(HERE, "answers.json"), "utf8"));
const A = answers["loc-hard"] ?? Object.values(answers)[0];

let fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? `  ← ${detail}` : ""}`);
  if (!cond) fail++;
};

const asJson = (spots) => JSON.stringify(spots.map((s) => ({ ...s, why: "x" })));

console.log("满分卷：把 ground truth 原样交上去");
{
  const r = scoreLocate(asJson(A.spots), A);
  check("文件召回 = 1", r.file_recall === 1, `实际 ${r.file_recall}`);
  check("文件精确 = 1", r.file_precision === 1, `实际 ${r.file_precision}`);
  check("行召回 = 1", r.line_recall === 1, `实际 ${r.line_recall}`);
}

console.log("\n只答对一个文件（ground truth 跨多文件时）");
{
  const one = A.spots.filter((s) => s.path === A.files[0]);
  const r = scoreLocate(asJson(one), A);
  check("文件精确仍为 1（答的都对）", r.file_precision === 1, `实际 ${r.file_precision}`);
  if (A.files.length > 1) {
    check("文件召回 < 1（漏了另一个）", r.file_recall < 1, `实际 ${r.file_recall}`);
    check("漏掉的文件被列出", r.missedFiles.length > 0);
  }
}

console.log("\n乱指");
{
  const r = scoreLocate(JSON.stringify([{ path: "packages/nope/src/nothing.ts", from_line: 1, to_line: 9 }]), A);
  check("文件召回 = 0", r.file_recall === 0);
  check("文件精确 = 0", r.file_precision === 0);
}

console.log("\n文件对但行号差得远");
{
  const s = A.spots[0];
  const r = scoreLocate(JSON.stringify([{ path: s.path, from_line: 99000, to_line: 99010 }]), A);
  check("文件仍算命中", r.file_precision === 1, `实际 ${r.file_precision}`);
  check("行号不算命中", r.line_recall === 0, `实际 ${r.line_recall}`);
}

console.log("\n广撒网：对的混在一堆错的里");
{
  const noise = Array.from({ length: 9 }, (_, i) => ({ path: `packages/x${i}/src/a.ts`, from_line: 1, to_line: 2 }));
  const r = scoreLocate(JSON.stringify([...A.spots.slice(0, 1), ...noise]), A);
  check("文件召回不受影响（确实找到了）", r.file_recall > 0);
  check("文件精确被拉低（乱指有代价）", r.file_precision < 0.2, `实际 ${r.file_precision}`);
}

console.log("\n输出形态");
{
  const body = asJson(A.spots.slice(0, 1));
  check("裸数组 → strict", parseLocations(body).strict === true);
  check("markdown fence → 非 strict 但能解析",
    parseLocations("```json\n" + body + "\n```").locations.length === 1);
  check("裸对象串 → 能解析",
    parseLocations("Here:\n" + A.spots.map((s) => JSON.stringify(s)).join(", ")).locations.length === A.spots.length);
  check("纯散文 → parseOk false", parseLocations("It's in the scheduler somewhere.").parseOk === false);
  check("空输出不炸", parseLocations("").locations.length === 0);
}

console.log(fail === 0 ? "\n定位判分自测全过。" : `\n${fail} 项未通过。`);
process.exit(fail ? 1 : 0);
