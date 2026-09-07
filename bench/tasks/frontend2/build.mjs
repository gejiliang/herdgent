#!/usr/bin/env node
// 造前端题：真实项目 + 真实 bugfix PR。
//
// 【为什么不再自建应用】：第一轮自建的三道题五家全满分、区分度 0 ——
// 自己造的难度校不准。真实 PR 的难度是现成的，不用猜。
//
// 【为什么用几天前的 PR】：避开训练污染。vuejs/core 的这几个 PR 都是 2026 年
// 7–8 月合并的，晚于任何模型的知识截止。这也是第一轮排除 SWE-bench 的理由之一。
//
// 题目形态是最干净的那种：给一个挂掉的测试，修到通过，不许改测试。
// 不给 issue 描述、不给 PR 说明 —— 那些会泄露解法方向。
// 真实场景里 CI 挂了也就是这样：你只知道哪条断言红了。
//
//   node bench/tasks/frontend2/build.mjs

import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = "vuejs/core";

// 难度按源码改动量分档。三道题都在 vuejs/core，消除「项目熟悉度」这个变量。
export const TASKS = [
  {
    id: "fe2-baseline", tier: "基线", pr: 15190,
    why: "4 行改动、单文件。KeepAlive 卸载时没清理缓存分支。预期多数能修。",
  },
  {
    id: "fe2-spread", tier: "分化", pr: 15143,
    why: "17 行、跨 2 文件。调度器在 flush 大量 watcher 时爆栈 —— 要看懂调度循环才改得对。",
  },
  {
    id: "fe2-hard", tier: "难", pr: 15124,
    why: "54 行、跨 2 文件、编译器侧。helper 与 cache 变量的作用域处理，比运行时的题更绕。",
  },
];

// 【选题时必须排除「测试依赖新 API」的 PR】（踩过）：
// #15158 的测试 import 了 VaporDirective / withVaporDirectives，而 base 里没有这些导出，
// 于是整个测试文件连解析都过不去 —— 0 过 0 挂。
// 那种 PR 不是纯 bugfix，是「顺手加了 API」，测试与源码逐字耦合，
// agent 不可能猜出确切的 API 名，题目本身不成立。
// 症状是 verify 里那条「不是整个文件都挂」失败。

const CAND = join(HERE, "candidates.json");
// 共享的 node_modules：三道题的 base commit 相近，依赖树一致。
// APFS clonefile 复制 447MB 是零点几秒且不实际占空间。
const NM = join(HERE, ".node_modules-cache");

async function gh(path, raw = false) {
  const args = raw
    ? ["api", path, "--jq", ".content"]
    : ["api", path];
  const { stdout } = await exec("gh", args, { maxBuffer: 128 * 1024 * 1024 });
  return stdout;
}

async function fileAt(ref, path) {
  const b64 = await gh(`repos/${REPO}/contents/${encodeURI(path)}?ref=${ref}`, true);
  return Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf8");
}

async function build() {
  if (!existsSync(CAND)) {
    console.error(`缺 ${CAND}（候选 PR 清单）。先跑筛选脚本生成。`);
    process.exit(66);
  }
  if (!existsSync(NM)) {
    console.error(
      `缺共享依赖 ${NM}。先准备一次：\n` +
        `  下载任一 base commit 的快照，跑 pnpm install --ignore-scripts，\n` +
        `  再把它的 node_modules 移到上面这个路径。`,
    );
    process.exit(66);
  }

  const cands = JSON.parse(await readFile(CAND, "utf8"));
  const answers = {};

  for (const t of TASKS) {
    const c = cands.find((x) => x.pr === t.pr);
    if (!c) throw new Error(`候选清单里没有 #${t.pr}`);

    const dir = join(HERE, "fixtures", t.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    process.stdout.write(`  ${t.id.padEnd(14)} #${t.pr} … `);

    // 1. base commit 的完整快照（bug 还在的状态）
    const tgz = join(dir, ".snap.tgz");
    await exec("sh", ["-c", `gh api repos/${REPO}/tarball/${c.base} > ${JSON.stringify(tgz)}`],
      { maxBuffer: 8 * 1024 * 1024 });
    await exec("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"]);
    await rm(tgz, { force: true });

    // 2. 把 PR 新增的测试覆盖进去 —— 这是红态的来源
    for (const tf of c.tests) {
      const content = await fileAt(c.head, tf);
      await mkdir(dirname(join(dir, tf)), { recursive: true });
      await writeFile(join(dir, tf), content);
    }

    // 3.【必须删掉仓库自带的 AGENTS.md / CLAUDE.md】
    //    各家对这类文件的支持不一样（有的自动读、有的完全不认），
    //    留着就等于给认它的那几家单独喂了一份项目指令 —— 是个真实的混淆变量。
    for (const f of ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".github/copilot-instructions.md"]) {
      await rm(join(dir, f), { force: true });
    }

    // 4. 依赖（clonefile，不实际占空间）
    try {
      await exec("cp", ["-c", "-R", NM, join(dir, "node_modules")]);
    } catch {
      await cp(NM, join(dir, "node_modules"), { recursive: true });
    }

    // 5. 题面：只说哪条测试挂了，不说为什么、不说在哪
    await writeFile(join(dir, "TASK.md"), [
      `# A test is failing`,
      ``,
      `This is the \`vuejs/core\` repository. Dependencies are already installed.`,
      ``,
      `The following test file has a failing test:`,
      ``,
      "```",
      c.tests.filter((f) => /\.spec\.[jt]sx?$/.test(f)).join("\n"),
      "```",
      ``,
      `Run it with:`,
      ``,
      "```sh",
      `./node_modules/.bin/vp test --project 'unit*' --run ${c.tests.filter((f) => /\.spec\.[jt]sx?$/.test(f))[0]}`,
      "```",
      ``,
      `Find the cause and fix it in the source, so that the whole file passes.`,
      ``,
      `Constraints:`,
      ``,
      `- **Do not modify any test file.** The fix belongs in the source.`,
      `- Do not install anything; the dependencies you need are already here.`,
      `- Do not weaken or delete assertions.`,
      `- Everything that passes today must still pass.`,
      ``,
    ].join("\n"));

    // 【要复制的文件】和【要跑的目标】不是一回事：__snapshots__/*.snap 也算测试资产、
    // 必须一起覆盖，但拿它当运行目标会得到「no tests」——vp 跑快照文件找不到任何用例。
    // 第一次就栽在这：fe2-hard 的 tests[0] 恰好是 .snap，看起来像 fixture 坏了。
    const runTests = c.tests.filter((f) => /\.spec\.[jt]sx?$/.test(f));
    if (!runTests.length) throw new Error(`#${t.pr} 没有可运行的 spec 文件`);
    answers[t.id] = {
      pr: t.pr, tier: t.tier, title: c.title, base: c.base, head: c.head,
      tests: c.tests, runTests, srcFiles: c.src, srcLines: c.src_lines,
    };
    console.log(`base ${c.base.slice(0, 8)} · 测试 ${c.tests.length} 个 · 源码 ${c.src_lines} 行/${c.src.length} 文件`);
  }

  // 答案单独落盘，不进 fixture —— 放进去 agent 一 grep 就看见改哪儿了
  await writeFile(join(HERE, "answers.json"), JSON.stringify(answers, null, 2));
  console.log(`\nfixture → ${join(HERE, "fixtures")}\nanswers → ${join(HERE, "answers.json")}（不在 fixture 内）`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await build();
}
