#!/usr/bin/env node
// 造定位题：在一个真实的大仓库里回答「实现 X 的代码在哪」。
//
// 【为什么加这一类】：第一轮最硬的发现是「读代码找问题」比「写代码」难得多 ——
// 评审三题拉开了差距，前端三题全员满分。定位正是「读」的核心动作，
// 而且它只读、跑得快、可以高频重复 —— n 容易上去，正好补第一轮 26/30 格 n=1 的短板。
//
// 【ground truth 从真实 PR 反推】：某个 bug 的修复动了哪些文件的哪些行，
// 那里就是「实现该功能」的地方。不用我自己读代码去指认，省成本也少主观。
//
// 【问题只描述功能，不描述 bug】。说「哪里处理 X」而不是「X 的 bug 在哪」——
// 后者等于告诉它去找异常，那测的是另一回事。

import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiffRanges } from "../review/lib/diff.mjs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FE2 = join(HERE, "..", "frontend2");
const REPO = "vuejs/core";

export const TASKS = [
  {
    id: "loc-baseline", tier: "基线", source: "fe2-baseline", pr: 15190,
    why: "单文件、名字就叫 KeepAlive，靠文件名就能猜到大方向。基线：找不到才说明有问题。",
    question:
      "In this repository, when a KeepAlive'd component is being unmounted, some code decides what happens to the branches it has cached — whether they are detached, kept, or removed outright.\n\nFind where that decision is made.",
  },
  {
    id: "loc-spread", tier: "分化", source: "fe2-spread", pr: 15143,
    why: "调度器的队列 flush 逻辑。文件名帮不上多少忙，要顺着调用链读。",
    question:
      "In this repository, the scheduler drains its queue of pending jobs — walking the queued work and running each item in order.\n\nFind where that draining loop lives.",
  },
  {
    id: "loc-hard", tier: "难", source: "fe2-hard", pr: 15124,
    why: "编译器给 helper 与缓存表达式生成变量名的地方，跨 2 个文件、名字毫无提示。",
    question:
      "In this repository, the vapor compiler generates JavaScript. While doing so it has to invent variable names — both for the runtime helpers it imports and for expressions it decides to cache.\n\nFind where those names are produced.",
  },
];

const OUT_CONTRACT = `
Answer with a single JSON array and nothing else. No prose before or after, no markdown fence.
Each element:
{"path": "<file path relative to the repository root>", "from_line": <int>, "to_line": <int>, "why": "<one sentence: what this code does>"}

List every location that is genuinely part of the answer, most relevant first.
If several files are involved, include each of them.
Do not modify any file — this is a read-only question.
`.trim();

async function build() {
  const answers = {};
  for (const t of TASKS) {
    const src = join(FE2, "fixtures", t.source);
    if (!existsSync(src)) {
      console.error(`缺源 fixture ${src}。先跑 bench/tasks/frontend2/build.mjs`);
      process.exit(66);
    }
    const dir = join(HERE, "fixtures", t.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    process.stdout.write(`  ${t.id.padEnd(13)} ← ${t.source} … `);
    try {
      await exec("cp", ["-c", "-R", src, dir]);
    } catch {
      await cp(src, dir, { recursive: true });
    }

    // 题面：只有问题和输出契约。原来那份 TASK.md 是修 bug 的，删掉换成定位题
    await writeFile(join(dir, "TASK.md"), `${t.question}\n\n${OUT_CONTRACT}\n`);

    // ground truth：这个 PR 在源码侧改动的位置
    const fe2Answers = JSON.parse(await readFile(join(FE2, "answers.json"), "utf8"));
    const meta = fe2Answers[t.source];
    const { stdout: patch } = await exec("gh", [
      "api", `repos/${REPO}/compare/${meta.base}...${meta.head}`,
      "-H", "Accept: application/vnd.github.v3.diff",
    ], { maxBuffer: 64 * 1024 * 1024 });

    const ranges = parseDiffRanges(patch);
    const spots = [];
    for (const f of meta.srcFiles) {
      const key = [...ranges.keys()].find((p) => p === f || p.endsWith(`/${f}`) || f.endsWith(`/${p}`));
      if (!key) continue;
      // 用 hunk 范围而不是纯 + 行：定位题问的是「这段逻辑在哪」，
      // 答在上下文行上同样算找对了地方
      for (const r of ranges.get(key).hunk) spots.push({ path: f, from_line: r.start, to_line: r.end });
    }
    if (!spots.length) throw new Error(`${t.id}: ground truth 为空`);

    answers[t.id] = {
      tier: t.tier, pr: t.pr, question: t.question,
      files: meta.srcFiles, spots,
    };
    console.log(`${spots.length} 个位置 / ${meta.srcFiles.length} 个文件`);
  }

  await writeFile(join(HERE, "answers.json"), JSON.stringify(answers, null, 2));
  console.log(`\nfixture → ${join(HERE, "fixtures")}\nanswers → ${join(HERE, "answers.json")}（不在 fixture 内）`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await build();
}
