#!/usr/bin/env node
// 题目自检：三道题是否都处在正确的「红」态。
//
// 要同时成立，缺一不可：
//   · 目标测试【有失败】—— 全绿说明 bug 不在了，题目等于做完了
//   · 失败【不是全挂】—— 整个文件跑不起来（依赖缺失、语法错）不是「有 bug」，
//     那是 fixture 坏了，agent 修的会是我们的错而不是 Vue 的 bug
//   · 题面里【没有答案】—— PR 的源码改动不能出现在快照里
//
// 第一轮的教训：断言本身必须自验。当时 toHaveTextContent 的子串匹配让
// 「bug 已注入」的检测悄悄失效，全绿了还以为是好的。

import { readFile, rm, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./build.mjs";
import { runVueTest } from "./lib/vp.mjs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, ".verify");

let fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? `  ← ${detail}` : ""}`);
  if (!cond) fail++;
};

const answers = JSON.parse(await readFile(join(HERE, "answers.json"), "utf8"));
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

for (const t of TASKS) {
  const a = answers[t.id];
  console.log(`\n${t.id} (${t.tier})  #${a.pr}  ${a.title.slice(0, 60)}`);
  const src = join(HERE, "fixtures", t.id);
  const dir = join(WORK, t.id);
  try {
    await exec("cp", ["-c", "-R", src, dir]);
  } catch {
    await exec("cp", ["-R", src, dir]);
  }

  const r = await runVueTest(dir, a.runTests[0]);
  check(`测试跑得起来（${r.passed} 过 / ${r.failed} 挂 / 共 ${r.total}）`, r.ranOk, r.tail);
  check(`未修复时有失败`, r.failed > 0, "全绿意味着 bug 不在了，题目等于做完了");
  check(
    `不是整个文件都挂（${r.passed} 条仍通过）`,
    r.passed > 0,
    "全挂说明 fixture 坏了 —— agent 会去修我们的错，不是 Vue 的 bug",
  );

  // 题面里不能有答案：PR 改的源码文件，内容必须还是 base 版本
  let leaked = 0;
  for (const f of a.srcFiles) {
    const cur = await readFile(join(dir, f), "utf8").catch(() => null);
    if (cur === null) {
      leaked++;
      continue;
    }
    const head = await exec("gh", [
      "api", `repos/vuejs/core/contents/${encodeURI(f)}?ref=${a.head}`, "--jq", ".content",
    ]).then((x) => Buffer.from(x.stdout.replace(/\s/g, ""), "base64").toString("utf8")).catch(() => null);
    if (head !== null && cur === head) leaked++;
  }
  check(`源码是未修复的 base 版本`, leaked === 0, `${leaked} 个文件已经是修好的了`);

  await rm(dir, { recursive: true, force: true });
}

await rm(WORK, { recursive: true, force: true });
console.log(fail === 0 ? "\n三道题都处在「红」态，可以开跑。" : `\n${fail} 项未通过 —— 题目还不能用。`);
process.exit(fail ? 1 : 0);
