#!/usr/bin/env node
// 打印把 herdgent 编排工具注册到各 harness 的命令。
//
// 【只打印，不执行】：这些命令要写用户的全局配置（~/.claude.json、~/.codex/config.toml），
// 那是用户的东西，插件不该代写——先 GET 再 PUT 的前提是人知道自己在 PUT 什么。
import { resolve } from "node:path";

const server = resolve(import.meta.dirname, "mcp-server.mjs");
const node = process.execPath;
const arg = process.argv[2];

const RECIPES = {
  claude: {
    title: "Claude Code",
    cmd: `claude mcp add --scope user herdgent -- ${node} ${server}`,
    note: "--scope user 表示对所有项目生效；换成 project 则只在当前仓库。",
  },
  codex: {
    title: "Codex",
    cmd: `codex mcp add herdgent -- ${node} ${server}`,
    note: null,
  },
  pi: {
    title: "Pi",
    cmd: null,
    note:
      "pi 没找到全局注册入口（--mcp-config 是 extension 的 flag，settings.json 里没有 mcpServers）。\n" +
      "    所以 pi 目前只能当 worker，不能当编排者——不影响主用途，跨厂商评审本来就是派给它。",
  },
};

const wanted = arg ? { [arg]: RECIPES[arg] } : RECIPES;
if (arg && !RECIPES[arg]) {
  console.error(`unknown harness '${arg}' (known: ${Object.keys(RECIPES).join(", ")})`);
  process.exit(2);
}

console.log("把 herdgent 的编排工具装进 harness —— 装完【每个会话】都能直接派活：\n");
for (const [kind, r] of Object.entries(wanted)) {
  console.log(`  ${r.title}`);
  if (r.cmd) console.log(`    ${r.cmd}`);
  if (r.note) console.log(`    ${r.note}`);
  console.log();
}
console.log("装完后在任意会话里说「用 herdgent 并行做这几件事」即可；");
console.log("worker 仍然跑在 herdr 的真终端里，随时能看能接管。");
console.log("卸载：claude mcp remove herdgent / codex mcp remove herdgent");
