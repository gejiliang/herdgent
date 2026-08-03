#!/usr/bin/env node
// 造前端 fixture：三道题各一份可直接开工的应用副本。
//
// 三条设计决定：
//
// 1.【node_modules 预装进 fixture】。不预装的话每次运行都要 npm install ——
//    而每次运行都是全新的假 HOME，装不到缓存，耗时指标会被网络下载主导。
//    评审那边已经踩过一次（pi 把整条 Go toolchain 拉进了 home/go/pkg/mod）。
//
// 2.【隐藏测试不进 fixture】。放进去 agent 就能照着断言写代码，测的就成了抄写能力。
//    判分时才把 specs/ 复制进 app/__bench__/ 跑。
//
// 3.【难题用 patch 覆盖】。基线与分化共用干净的 app；难题额外盖上 hard-patch/，
//    把「冗余 total 只在 add 时维护」这个 bug 装进去。

import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

export const TASKS = [
  { id: "fe-baseline", tier: "基线", req: "baseline", spec: "baseline.test.jsx", patch: null,
    why: "加一个备注字段：表单收、reducer 存、列表显示，三处都得动。预期五家都能过。" },
  { id: "fe-spread", tier: "分化", req: "spread", spec: "spread.test.jsx", patch: null,
    why: "按分类筛选。分水岭是合计要不要跟着筛选走 —— 只改列表不改合计，功能看着是好的但数字不对。" },
  { id: "fe-hard", tier: "难", req: "hard", spec: "hard.test.jsx", patch: "hard-patch",
    why: "只给症状不给位置。真因是 state 里冗余的 total 只在 add 时维护，remove 漏了。" },
];

async function build() {
  const app = join(HERE, "app");
  try {
    await readFile(join(app, "node_modules", ".package-lock.json"));
  } catch {
    console.error(`app/node_modules 不在。先执行：\n  cd ${app} && npm install`);
    process.exit(66);
  }

  for (const t of TASKS) {
    const dir = join(HERE, "fixtures", t.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });

    process.stdout.write(`  ${t.id.padEnd(13)} `);
    // APFS clonefile：70MB 的 node_modules 也是零点几秒且不实际占空间
    try {
      await exec("cp", ["-c", "-R", app, dir]);
    } catch {
      await cp(app, dir, { recursive: true });
    }

    if (t.patch) {
      await cp(join(HERE, t.patch), dir, { recursive: true, force: true });
    }

    // 题面：agent 看得到的全部信息
    const req = await readFile(join(HERE, "requirements", `${t.req}.md`), "utf8");
    await writeFile(join(dir, "TASK.md"), req);

    // 保险：确认隐藏测试没混进去
    await rm(join(dir, "__bench__"), { recursive: true, force: true });

    console.log(`${t.tier} —— ${t.why}`);
  }

  console.log(`\nfixture → ${join(HERE, "fixtures")}`);
  console.log(`隐藏测试留在 ${join(HERE, "specs")}（不在 fixture 内，故意的）`);
}

// 【只在直接运行时才造】。run.mjs / verify-fixtures.mjs 会 import 上面的 TASKS，
// 顶层无条件 build 的话，它们一启动就把正在用的 fixture 重建一遍 —— 正在跑的那次
// 工作副本会被覆盖掉。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await build();
}
