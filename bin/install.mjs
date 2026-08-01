#!/usr/bin/env node
// 把当前工作副本安装到 ~/.herdgent，并把 harness 的 MCP 指过去。
//
// 为什么要有安装副本：MCP 配置里存的是绝对路径。指向开发工作副本的话，
// 改一行代码就立刻影响用户【正在用】的所有会话——半成品会直接砸到生产上。
// 隔一个显式的 install 步骤，改动什么时候生效由人决定。
//
// 用法：
//   node bin/install.mjs            装/更新 ~/.herdgent 并注册 MCP
//   node bin/install.mjs --dry-run  只看要做什么
//   node bin/install.mjs --print    只打印注册命令，自己去跑
import {
  cpSync,
  mkdirSync,
  rmSync,
  existsSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { herdgentHome, stateRoot, configRoot, workflowsRoot, legacyPaths } from "../lib/paths.mjs";

// 【顶层代码不许用 20.11+ 的 API】：Node 版本不够正是这个脚本要拦的场景之一，
// 而顶层语句排在 preflight() 之前——这里用 import.meta.dirname（20.11 才有）的话，
// 低版本上会先炸出一条原始 TypeError，「需要 Node ≥ 20.11、怎么升级」永远打印不出来。
// fileURLToPath 从 Node 10 就在。
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = herdgentHome();
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const printOnly = argv.includes("--print");

// 只搬运行时需要的东西。test/ 和 docs/ 不进安装副本——它们只在开发树里有意义，
// 而 test/ 里那些会真起会话的脚本尤其不该出现在用户装好的目录里。
const RUNTIME = ["bin", "lib", "skills", "herdr-plugin.toml", "package.json", "LICENSE", "NOTICE"];

function gitInfo() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: SRC, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: SRC, encoding: "utf8" }).trim();
    return { commit, dirty: dirty.length > 0 };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: !r.error && r.status === 0, out: (r.stdout || "") + (r.stderr || ""), code: r.status };
}

// ---- 前置依赖检查 ----
// 逐段比数字，不是字符串比较：字符串比较会把 0.7.10 判成低于 0.7.5。
const MIN_HERDR = [0, 7, 5];
const MIN_NODE = [20, 11, 0];

function parseVersion(text) {
  const m = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// 四项全查完再一次性报，不在第一项就退出——否则装的人得来回试三轮。
function preflight() {
  const problems = [];

  const herdr = run("herdr", ["--version"]);
  if (!herdr.ok) {
    problems.push([
      "herdr 命令不可用（不在 PATH 里，或跑不起来）",
      `怎么补：装 herdr 并确保它在 PATH 里，装完 \`herdr --version\` 应 ≥ ${MIN_HERDR.join(".")}`,
    ]);
  } else {
    const v = parseVersion(herdr.out);
    if (!v) {
      problems.push([
        `herdr 版本认不出来：${herdr.out.trim().split("\n")[0] ?? "(空输出)"}`,
        `怎么补：确认 \`herdr --version\` 能打出版本号，且 ≥ ${MIN_HERDR.join(".")}`,
      ]);
    } else if (cmpVersion(v, MIN_HERDR) < 0) {
      problems.push([
        `herdr 版本太低：${v.join(".")}，需要 ≥ ${MIN_HERDR.join(".")}`,
        "怎么补：herdr update",
      ]);
    }
  }

  const nodeVer = parseVersion(process.versions.node);
  if (!nodeVer || cmpVersion(nodeVer, MIN_NODE) < 0) {
    problems.push([
      `Node 版本太低：${process.versions.node}，需要 ≥ ${MIN_NODE.slice(0, 2).join(".")}`,
      "怎么补：升级 Node（nvm install 20 && nvm use 20，或 brew upgrade node），再重跑本脚本",
    ]);
  }

  const hasGit = run("git", ["--version"]).ok;
  if (!hasGit) {
    problems.push(["git 命令不可用（不在 PATH 里，或跑不起来）", "怎么补：装 git（macOS: xcode-select --install，或 brew install git）"]);
  } else if (!run("git", ["-C", SRC, "rev-parse", "--is-inside-work-tree"]).ok) {
    // 装的是「当前磁盘状态」，得能记下它对应哪个 commit；不是 git 仓库就无从追溯。
    problems.push([`源目录不是 git 仓库：${SRC}`, "怎么补：在仓库的工作副本里跑本脚本（git clone 出来的目录，或 herdr worktree create 建的 worktree）"]);
  }

  return problems;
}

const git = gitInfo();
const version = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version;
const node = process.execPath;
const server = join(DEST, "bin", "mcp-server.mjs");

const MCP_CMDS = [
  {
    kind: "claude",
    bin: "claude",
    add: ["mcp", "add", "--scope", "user", "herdgent", "--", node, server],
    remove: ["mcp", "remove", "--scope", "user", "herdgent"],
  },
  {
    kind: "codex",
    bin: "codex",
    add: ["mcp", "add", "herdgent", "--", node, server],
    remove: ["mcp", "remove", "herdgent"],
  },
];

console.log(`herdgent ${version} (${git.commit}${git.dirty ? ", 工作区有未提交改动" : ""})`);
console.log(`  源: ${SRC}`);
console.log(`  目标: ${DEST}\n`);

// 检查整体排在所有副作用（复制、MCP 注册、plugin link）之前：装到一半才失败
// 留下的是半新半旧的 ~/.herdgent，比什么都没装更难收拾。
//
// --print / --dry-run 例外：这两个模式本身没有副作用，检查不过只打印 ⚠️ 提示、
// 照常往下走、退出码仍是 0。GG 拍板：环境没配好时最需要看的恰恰是「要做什么、
// 缺什么」，把这两个模式也拦掉等于把唯一的诊断手段一起关了。
const problems = preflight();
if (problems.length) {
  const fatal = !dryRun && !printOnly;
  console.log(`${fatal ? "✗" : "⚠️ "} 前置依赖不满足（${problems.length} 项）：\n`);
  for (const [what, how] of problems) {
    console.log(`  · ${what}`);
    console.log(`    ${how}\n`);
  }
  if (fatal) {
    console.log("都补齐后再跑一次 node bin/install.mjs。什么都没动。");
    process.exit(1);
  }
}

if (printOnly) {
  console.log("注册命令（自己跑）：");
  for (const c of MCP_CMDS) console.log(`  ${c.bin} ${c.add.join(" ")}`);
  console.log(`\nherdr 插件：\n  herdr plugin unlink herdgent  # 若之前 link 的是开发副本\n  herdr plugin link ${DEST}`);
  process.exit(0);
}

if (git.dirty) {
  // 不拦，只提醒：装一个有未提交改动的版本是合理的（就是想试），但你得知道自己在装什么。
  console.log("⚠️  工作区有未提交改动，安装的是【当前磁盘状态】而不是某个 commit\n");
}

if (dryRun) {
  console.log("--dry-run，实际什么都不做。会执行的是：");
  console.log(`  1. 复制 ${RUNTIME.join(", ")} → ${DEST}`);
  for (const c of MCP_CMDS) console.log(`  2. ${c.bin} ${c.add.join(" ")}`);
  console.log(`  3. herdr plugin link ${DEST}`);
  process.exit(0);
}

// ---- 1. 同步文件 ----
// 先删再拷：留着旧文件会让删掉的模块在安装副本里阴魂不散。
if (existsSync(DEST)) {
  for (const item of RUNTIME) rmSync(join(DEST, item), { recursive: true, force: true });
}
mkdirSync(DEST, { recursive: true });
for (const item of RUNTIME) {
  const from = join(SRC, item);
  if (!existsSync(from)) continue;
  cpSync(from, join(DEST, item), { recursive: true });
}
writeFileSync(
  join(DEST, "INSTALLED.json"),
  JSON.stringify(
    { version, commit: git.commit, dirty: git.dirty, source: SRC, installed_at: new Date().toISOString() },
    null,
    2,
  ) + "\n",
);
console.log(`✓ 已同步到 ${DEST}`);

// config/ 和 state/ 是【用户的】，只保证存在，绝不覆盖里面的东西。
mkdirSync(configRoot(), { recursive: true });
mkdirSync(workflowsRoot(), { recursive: true });
mkdirSync(stateRoot(), { recursive: true });
const readme = join(workflowsRoot(), "README.md");
if (!existsSync(readme)) {
  writeFileSync(
    readme,
    [
      "# 自定义编排工作流",
      "",
      "这个目录下每个 `<name>.md` 就是一份工作流，编排者用 `orchestration_guide(workflow: \"<name>\")` 读它。",
      "",
      "工作流是 **prompt 不是代码**——写「谁评审谁、什么算验收、失败了怎么办」，",
      "而不是写怎么调工具（那些在工具描述里）。可以从内置的",
      "`../../skills/orchestrate/SKILL.md` 抄一份改。",
      "",
      "`install` 不会覆盖这个目录。",
      "",
    ].join("\n"),
  );
}
console.log(`✓ config → ${configRoot()}（profiles.json、workflows/，install 不覆盖）`);
console.log(`✓ state  → ${stateRoot()}`);

// 两份 playbook 同时也是各 harness 的 skill —— 用户打 /rex 或 /fox 就进编排。
//
// 【唯一真源 + 软链】：真源是 ~/.herdgent/skills，往各 harness 的 skills 目录
// 建软链，而不是拷贝。拷贝会变成好几份各自漂移的副本，改一处修不完。
// 只装到【已经存在】的 harness 目录——没装 codex 就不该给它建目录。
const SKILL_DIRS = [
  { kind: "claude", dir: join(homedir(), ".claude", "skills"), parent: join(homedir(), ".claude") },
  { kind: "codex", dir: join(homedir(), ".codex", "skills"), parent: join(homedir(), ".codex") },
  { kind: "pi", dir: join(homedir(), ".pi", "agent", "skills"), parent: join(homedir(), ".pi", "agent") },
];
const skillNames = existsSync(join(DEST, "skills")) ? readdirSync(join(DEST, "skills")) : [];
for (const { kind, dir, parent } of SKILL_DIRS) {
  if (!existsSync(parent)) {
    console.log(`  ${kind} 没装，跳过`);
    continue;
  }
  try {
    mkdirSync(dir, { recursive: true });
    const linked = [];
    for (const name of skillNames) {
      const target = join(dir, name);
      const src = join(DEST, "skills", name);
      // 已有【非软链】的同名 skill 是用户自己的东西，不碰。
      if (existsSync(target) && !lstatSync(target).isSymbolicLink()) {
        console.log(`  ${kind}/${name} 已存在且不是软链，跳过`);
        continue;
      }
      rmSync(target, { recursive: true, force: true });
      symlinkSync(src, target);
      linked.push(name);
    }
    console.log(`✓ ${kind} skill → ${linked.map((n) => `/${n}`).join(" ")}`);
  } catch (e) {
    console.log(`⚠️  ${kind} skill 装不上：${e.message}`);
  }
}

// 0.4.0 之前 state/config 跟着 herdr 的插件目录走。只在【有内容】时提示，
// 不自动搬——把两份都当真的合并出来的表会很诡异。
//
// 空目录不提示也删不掉：herdr 每次启动插件命令前都会重建它们（它要注入
// HERDR_PLUGIN_STATE_DIR）。herdgent 不读也不写那里，留着无害。
for (const [kind, dir] of Object.entries(legacyPaths())) {
  if (!existsSync(dir)) continue;
  const leftover = readdirSync(dir).filter((f) => f !== ".DS_Store");
  if (leftover.length) {
    console.log(`⚠️  旧 ${kind} 目录还有东西：${dir}`);
    console.log(`    ${leftover.join(", ")}`);
    console.log(`    需要的话自己搬到 ${kind === "state" ? stateRoot() : configRoot()}，herdgent 已经不读那里了`);
  }
}

// ---- 2. 注册 MCP ----
for (const c of MCP_CMDS) {
  // 先移除同名再加，否则旧的绝对路径会留在配置里。用两个 CLI 自己的命令读写配置，
  // 不手改 JSON——先 GET 再 PUT 的等价做法。
  const rm = run(c.bin, c.remove);
  const add = run(c.bin, c.add);
  console.log(
    add.ok
      ? `✓ ${c.kind}: 已注册 → ${server}`
      : `✗ ${c.kind}: 注册失败（${add.code}）${add.out.trim().split("\n")[0] ?? ""}`,
  );
  if (!add.ok && rm.ok) console.log(`   注意：旧条目已被移除，${c.kind} 现在没有 herdgent`);
}

// ---- 3. herdr 插件指向安装副本 ----
const unlink = run("herdr", ["plugin", "unlink", "herdgent"]);
const link = run("herdr", ["plugin", "link", DEST, "--enabled"]);
console.log(link.ok ? `✓ herdr plugin → ${DEST}` : `✗ herdr plugin link 失败：${link.out.trim().slice(0, 120)}`);
if (!link.ok && unlink.ok) console.log("   注意：旧的 link 已解除，插件当前未安装");

console.log("\n装好了。【已经开着的会话不会自动加载新版本】——新开会话才生效。");
console.log("改完代码想让它生效：再跑一次 node bin/install.mjs");
