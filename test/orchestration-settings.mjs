#!/usr/bin/env node
// 编排设置的回退与送达路径。不起 worker；socket 明确指向不存在的位置。
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(import.meta.dirname, "../bin/mcp-server.mjs");
const home = mkdtempSync(join(tmpdir(), "hg-orchestration-settings-"));
const state = join(home, "state");
const config = join(home, "config");
const registryFile = join(state, "registry.json");
const socket = join(home, "no-such-herdr.sock");
const root = "orchestration-settings-probe";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function parseToolReply(reply) {
  if (!reply.result) return { rpcError: reply.error };
  const text = reply.result.content?.[0]?.text ?? "{}";
  try {
    return { isError: !!reply.result.isError, ...JSON.parse(text) };
  } catch {
    return { isError: !!reply.result.isError, raw: text };
  }
}

function probe(maxWorkers, calls) {
  return new Promise((resolveProbe, rejectProbe) => {
    const proc = spawn(process.execPath, [SERVER, "--root", root, "--state-dir", state, "--max-workers", String(maxWorkers)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HERDGENT_HOME: home,
        HERDGENT_STATE_DIR: state,
        HERDGENT_CONFIG_DIR: config,
        HERDR_SOCKET_PATH: socket,
      },
    });
    let buffer = "";
    let nextId = 1;
    const pending = new Map();
    const send = (method, params) => {
      const id = nextId++;
      return new Promise((resolveReply, rejectReply) => {
        pending.set(id, { resolve: resolveReply, reject: rejectReply });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    };

    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const reply = JSON.parse(line);
        if (reply.id !== undefined && pending.has(reply.id)) {
          pending.get(reply.id).resolve(reply);
          pending.delete(reply.id);
        }
      }
    });
    const rejectPending = (error) => {
      for (const { reject } of pending.values()) reject(error);
      pending.clear();
    };
    proc.on("error", (error) => {
      rejectPending(error);
      rejectProbe(error);
    });
    proc.on("exit", (code, signal) => {
      if (pending.size === 0) return;
      rejectPending(new Error(`MCP server exited before replying (code ${code ?? "null"}, signal ${signal ?? "none"})`));
    });

    (async () => {
      await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      const results = {};
      for (const call of calls) {
        const reply = await send("tools/call", { name: call.name, arguments: call.arguments ?? {} });
        results[call.key] = parseToolReply(reply);
      }
      proc.stdin.end();
      proc.kill();
      resolveProbe(results);
    })().catch((error) => {
      proc.kill();
      rejectProbe(error);
    });
  });
}

try {
  process.env.HERDGENT_HOME = home;
  process.env.HERDGENT_STATE_DIR = state;
  process.env.HERDGENT_CONFIG_DIR = config;
  process.env.HERDR_SOCKET_PATH = socket;
  const { cleanupAfterAccept } = await import(`../lib/config.mjs?t=${Date.now()}`);
  const configFile = join(config, "config.json");

  check("配置文件不存在 → keep", cleanupAfterAccept() === "keep", cleanupAfterAccept());

  mkdirSync(config, { recursive: true });
  writeFileSync(configFile, "{not json");
  check("坏 JSON → keep", cleanupAfterAccept() === "keep", cleanupAfterAccept());

  writeFileSync(configFile, JSON.stringify({ unrelated: true }));
  check("缺少 cleanup_after_accept → keep", cleanupAfterAccept() === "keep", cleanupAfterAccept());

  writeFileSync(configFile, JSON.stringify({ cleanup_after_accept: "later" }));
  check("非法 cleanup_after_accept → keep", cleanupAfterAccept() === "keep", cleanupAfterAccept());

  writeFileSync(configFile, JSON.stringify({ cleanup_after_accept: "auto" }));
  check("auto 被正确读取", cleanupAfterAccept() === "auto", cleanupAfterAccept());

  const initial = await probe(6, [{ key: "workers", name: "list_workers" }]);
  check("未显式设置时采用第一次启动值", initial.workers.limit === 6, `limit=${initial.workers.limit}`);

  const changed = await probe(16, [{ key: "workers", name: "list_workers" }]);
  check("未显式设置时后续启动值生效", changed.workers.limit === 16, `limit=${changed.workers.limit}`);

  writeFileSync(
    registryFile,
    JSON.stringify({ version: 2, sessions: {}, orchestrations: { [root]: { root, max_workers: 6 } } }),
  );
  const legacy = await probe(16, [{ key: "workers", name: "list_workers" }]);
  check("历史 max_workers 不覆盖当前启动值", legacy.workers.limit === 16, `limit=${legacy.workers.limit}`);

  const explicit = await probe(16, [{ key: "set", name: "set_worker_limit", arguments: { limit: 9 } }]);
  check("set_worker_limit 写入显式值", explicit.set.limit === 9, `limit=${explicit.set.limit}`);
  const explicitRecord = JSON.parse(readFileSync(registryFile, "utf8")).orchestrations[root];
  check(
    "显式上限走新键，旧键只作历史保留",
    explicitRecord.max_workers_explicit === 9 && explicitRecord.max_workers === 6,
    JSON.stringify(explicitRecord),
  );

  const retained = await probe(3, [{ key: "workers", name: "list_workers" }]);
  check("显式值不会被后续启动覆盖", retained.workers.limit === 9, `limit=${retained.workers.limit}`);

  const guide = await probe(3, [
    { key: "withoutMode", name: "orchestration_guide" },
    { key: "withMode", name: "orchestration_guide", arguments: { mode: "rex" } },
  ]);
  check("无参数 guide 带收尾策略", guide.withoutMode.cleanup_after_accept === "auto", guide.withoutMode.cleanup_after_accept);
  check("mode guide 带收尾策略", guide.withMode.cleanup_after_accept === "auto", guide.withMode.cleanup_after_accept);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
