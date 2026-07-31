#!/usr/bin/env node
// 身份自判验收：MCP server 从三条路启动时，认不认得出自己是谁。
//
// 不需要 herdr server（只读 registry + 走协议），所以进 npm test。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(import.meta.dirname, "../bin/mcp-server.mjs");
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// 起一个 MCP server，握手 + 列工具 + ping，然后关掉。
function probe({ args = [], env = {}, probeSpawn = false } = {}) {
  return new Promise((res, rej) => {
    const proc = spawn(process.execPath, [SERVER, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let buf = "";
    const out = {};
    const pending = new Map();
    let nextId = 1;
    const send = (method, params) => {
      const id = nextId++;
      return new Promise((r) => {
        pending.set(id, r);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    };
    proc.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    proc.on("error", rej);
    (async () => {
      await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      const tools = await send("tools/list", {});
      out.tools = (tools.result?.tools ?? []).map((t) => t.name).sort();
      const ping = await send("tools/call", { name: "ping", arguments: {} });
      out.ping = JSON.parse(ping.result?.content?.[0]?.text ?? "{}");

      // ⚠️ 只在【预期会被拒】的身份上调 spawn_worker。
      // 编排者身份下这个调用会【真的去建 workspace、真的起一个 agent】——
      // 曾经在这里翻过车：以为 HERDR_SOCKET_PATH="" 能让它连不上，
      // 但空字符串是 falsy，herdr CLI 于是连了 default session，
      // 在用户的工作区里留下 5 个探针会话。
      if (probeSpawn) {
        const spawnTry = await send("tools/call", {
          name: "spawn_worker",
          arguments: { title: "identity-probe", task: "must never actually run" },
        });
        out.spawnResult = spawnTry.result
          ? { isError: !!spawnTry.result.isError, ...JSON.parse(spawnTry.result.content?.[0]?.text ?? "{}") }
          : { rpcError: spawnTry.error };
      }
      proc.stdin.end();
      proc.kill();
      res(out);
    })().catch(rej);
  });
}

// 第二层保险：把 herdr socket 指向一个不存在的路径。即使将来某个断言写漏了，
// 也不可能连上真的 herdr 去建东西。测试【永远】不该有碰到 default session 的可能。
const DEAD_SOCKET = join(tmpdir(), "hg-identity-no-such-herdr.sock");

const state = mkdtempSync(join(tmpdir(), "hg-identity-"));
mkdirSync(state, { recursive: true });

// 造一张登记表：w9:p1 是某次编排的 worker
writeFileSync(
  join(state, "registry.json"),
  JSON.stringify({
    version: 2,
    sessions: {
      "claude:aaa": {
        key: "claude:aaa",
        slug: "wk1",
        role: "worker",
        root: "orc-test",
        title: "some-task",
        pane_id: "w9:p1",
        status: "active",
        harness: "claude",
      },
    },
    orchestrations: { "orc-test": { root: "orc-test", max_workers: 6 } },
  }),
);

try {
  // ---- 1. 裸终端（没有 HERDR_PANE_ID）：必然是编排者 ----
  const cli = await probe({
    env: { HERDGENT_STATE_DIR: state, HERDR_PANE_ID: "", HERDR_SOCKET_PATH: DEAD_SOCKET },
  });
  check("CLI 直连被判为编排者", cli.ping.role === "orchestrator", cli.ping.role);
  check("CLI 直连 root 是一次性的", String(cli.ping.root).startsWith("orc:cli:"), cli.ping.root);
  check("编排者拿得到 spawn_worker", cli.tools.includes("spawn_worker"));

  // ---- 2. herdr 里的 worker pane：认出自己是 worker ----
  const worker = await probe({
    env: { HERDGENT_STATE_DIR: state, HERDR_PANE_ID: "w9:p1", HERDR_SOCKET_PATH: DEAD_SOCKET },
    probeSpawn: true, // 只有这个身份下 spawn 必被拒，才安全
  });
  check("worker pane 被判为 worker", worker.ping.role === "worker", worker.ping.role);
  check("worker 继承所属编排的 root", worker.ping.root === "orc-test", worker.ping.root);
  check("worker 的工具列表里没有 spawn_worker", !worker.tools.includes("spawn_worker"), worker.tools.join(","));
  check("worker 仍保留只读工具", worker.tools.includes("read_worker") && worker.tools.includes("list_workers"));
  // 两层防护，任一生效即可：
  //   外层——工具压根没注册，MCP 直接 -32602 unknown tool（实际走的是这层）
  //   内层——assertCanSpawn 抛 workers_cannot_spawn（万一某天工具又被注册上）
  const refused =
    worker.spawnResult.rpcError?.code === -32602 ||
    (worker.spawnResult.isError && worker.spawnResult.error === "workers_cannot_spawn");
  check("worker 硬调 spawn_worker 被拒", refused, JSON.stringify(worker.spawnResult).slice(0, 90));

  // ---- 3. 显式 --root（orchestrate action 那条路）----
  const explicit = await probe({
    args: ["--root", "orc-explicit"],
    env: { HERDGENT_STATE_DIR: state, HERDR_PANE_ID: "w9:p1", HERDR_SOCKET_PATH: DEAD_SOCKET },
  });
  check("显式 --root 优先于自动推导", explicit.ping.root === "orc-explicit", explicit.ping.root);
  check("显式 --root 时是编排者", explicit.ping.role === "orchestrator", explicit.ping.role);
} finally {
  rmSync(state, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
