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
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const SRC = resolve(import.meta.dirname, "..");
const DEST = process.env.HERDGENT_HOME || join(homedir(), ".herdgent");
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
