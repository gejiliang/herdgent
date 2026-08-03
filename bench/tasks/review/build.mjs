#!/usr/bin/env node
// 从 AACR-Bench 造评审 fixture：每道题 = 代码快照 + diff + 隐藏的标注答案。
//
// 三条不显然的设计决定：
//
// 1.【给 target 快照，不给 base】。标注的行号是 side="right"，也就是改动后那一侧。
//    给 base 的话行号对不上，agent 也看不到它要评的最终代码。
//
// 2.【快照里绝不能有 .git】。留着的话 agent 一句 `git log` 就能翻到后续的修复 commit，
//    等于把答案摆在桌上。用 tarball 而不是 clone 正是为此 —— 顺带省掉整个历史的体积。
//
// 3.【答案与题面分开落盘】。answers.json 不进 fixture 目录，判分器单独读。
//    放一起的话 agent 在工作目录里 grep 一下就全拿到了。

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// 三道梯度题。挑选过程见 bench/README.md —— 196 个 PR 里只有 12 个通过全部门槛。
export const TASKS = [
  {
    id: "review-baseline",
    tier: "基线",
    repo: "ollama/ollama",
    pr: 9379,
    why: "5 个问题全是 Diff Level —— 信息都在 diff 里，谁都该找得到。这是校准线：在这题上失手才说明真出了问题。",
  },
  {
    id: "review-spread",
    tier: "分化",
    repo: "libsdl-org/SDL",
    pr: 12964,
    why: "只改了 48 行却埋着 7 个问题，其中 2 个要跨仓库看上下文才发现。差距主要从这题读出来。",
  },
  {
    id: "review-hard",
    tier: "难",
    repo: "wavetermdev/waveterm",
    pr: 1998,
    why: "792 行、13 个文件，该报 14 个、另有 7 条不该报的诱饵。同时压召回和噪声。",
  },
];

const DATASET = process.env.AACR_DIR
  ? join(process.env.AACR_DIR, "dataset")
  : join(HERE, ".aacr", "dataset");

async function gh(path, jq) {
  const args = ["api", path];
  if (jq) args.push("--jq", jq);
  const { stdout } = await exec("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function build() {
  if (!existsSync(DATASET)) {
    console.error(
      `找不到 AACR-Bench 数据集：${DATASET}\n` +
        `先执行：git clone --depth 1 https://github.com/alibaba/aacr-bench ${join(HERE, ".aacr")}\n` +
        `或设 AACR_DIR 指向已有的 checkout。`,
    );
    process.exit(66);
  }

  const pos = JSON.parse(await readFile(join(DATASET, "positive_samples.json"), "utf8"));
  const neg = JSON.parse(await readFile(join(DATASET, "negative_samples.json"), "utf8"));

  const answers = {};
  for (const t of TASKS) {
    const url = `https://github.com/${t.repo}/pull/${t.pr}`;
    const p = pos.find((s) => s.githubPrUrl === url);
    if (!p) throw new Error(`positive 样本里找不到 ${url}`);
    const n = neg.find((s) => s.githubPrUrl === url);

    const dir = join(HERE, "fixtures", t.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, "repo"), { recursive: true });

    process.stdout.write(`  ${t.id.padEnd(16)} ${t.repo}#${t.pr} … `);

    // diff：用 .diff 媒体类型直接拿统一 diff，行号与标注同一套坐标系
    const { stdout: rawDiff } = await exec("gh", [
      "api", `repos/${t.repo}/compare/${p.source_commit}...${p.target_commit}`,
      "-H", "Accept: application/vnd.github.v3.diff",
    ], { maxBuffer: 64 * 1024 * 1024 });
    await writeFile(join(dir, "pr.diff"), rawDiff);

    // 代码快照：tarball of target_commit，解开后剥掉顶层目录
    const tgz = join(dir, ".snapshot.tar.gz");
    await exec("sh", ["-c",
      `gh api repos/${t.repo}/tarball/${p.target_commit} > ${JSON.stringify(tgz)}`,
    ], { maxBuffer: 8 * 1024 * 1024 });
    await exec("tar", ["-xzf", tgz, "-C", join(dir, "repo"), "--strip-components=1"]);
    await rm(tgz, { force: true });

    // 题面：agent 看得到的全部信息
    await writeFile(
      join(dir, "PR.md"),
      [
        `# Pull Request: ${t.repo}#${t.pr}`,
        ``,
        `- Repository: ${t.repo}`,
        `- Base commit: ${p.source_commit}`,
        `- Head commit: ${p.target_commit}`,
        `- Primary language: ${p.project_main_language}`,
        `- Change size: ${p.change_line_count} lines`,
        ``,
        `The full source tree at the head commit is in \`repo/\`.`,
        `The unified diff of this pull request is in \`pr.diff\`.`,
        ``,
      ].join("\n"),
    );

    const pick = (c) => ({
      note: c.note, path: c.path, from_line: c.from_line, to_line: c.to_line,
      category: c.category, context: c.context, side: c.side,
    });
    answers[t.id] = {
      repo: t.repo, pr: t.pr, tier: t.tier,
      positive: (p.comments ?? []).map(pick),
      negative: (n?.comments ?? []).map(pick),
    };

    console.log(`diff ${(rawDiff.length / 1024).toFixed(0)}KB · 该报 ${p.comments.length} · 噪声 ${n?.comments?.length ?? 0}`);
  }

  // 【答案单独落盘，不进 fixture】——放 fixtures/ 里 agent 一 grep 就全看见了
  await writeFile(join(HERE, "answers.json"), JSON.stringify(answers, null, 2));
  console.log(`\nfixture → ${join(HERE, "fixtures")}\nanswers → ${join(HERE, "answers.json")}（不在 fixture 内，故意的）`);
}

await build();
