#!/usr/bin/env node
// registry 并发写验收。零依赖，直接 `node test/concurrent-registry.mjs`。
//
// 编排上线后每个 orchestrator 会话都有自己的 MCP server 进程，它们并发写同一张表。
// 这里用真的多进程验证，不用单进程模拟——丢更新恰恰只在跨进程时出现。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIB = pathToFileURL(resolve(import.meta.dirname, "../lib/registry.mjs")).href;
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "herdgent-test-"));
}

function readRegistry(dir) {
  return JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"));
}

// 每个子进程写一条，模拟 N 个独立的 MCP server 同时登记 worker。
function spawnWriter(dir, key) {
  const code = `
    import { put } from ${JSON.stringify(LIB)};
    put({ key: process.env.HG_KEY, role: "worker", status: "active", root: "r1" });
  `;
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, HG_KEY: key, HERDGENT_STATE_DIR: dir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`writer ${key} exit ${c}: ${err}`))));
  });
}

// ---- 1. N 个进程并发 put，一条都不能丢 ----
{
  const N = 20;
  const dir = freshDir();
  try {
    await Promise.all(Array.from({ length: N }, (_, i) => spawnWriter(dir, `w${i}`)));
    const reg = readRegistry(dir);
    const keys = Object.keys(reg.sessions);
    check(`${N} 个进程并发 put 无丢失`, keys.length === N, `实得 ${keys.length} 条`);
    check(
      "每条内容完整",
      keys.every((k) => reg.sessions[k].role === "worker" && reg.sessions[k].root === "r1"),
    );
    check("锁目录已释放", !existsSync(join(dir, "registry.lock")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 2. 并发计数只数活着的 worker ----
{
  const dir = freshDir();
  try {
    const { put, countLive } = await import(`${LIB}?t=${Date.now()}`);
    process.env.HERDGENT_STATE_DIR = dir;
    put({ key: "a", role: "worker", status: "active", root: "r1" });
    put({ key: "b", role: "worker", status: "dead", root: "r1" });
    put({ key: "c", role: "worker", status: "active", root: "r2" });
    put({ key: "d", role: "standalone", status: "active" });
    const n = countLive("r1");
    check("countLive 全局只数活 worker", n.global === 2, `实得 ${n.global}`);
    check("countLive 按 root 过滤", n.inRoot === 1, `实得 ${n.inRoot}`);
  } finally {
    delete process.env.HERDGENT_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 3. 过期锁会被抢占（持锁进程被 kill 掉的场景）----
{
  const dir = freshDir();
  try {
    process.env.HERDGENT_STATE_DIR = dir;
    const { put } = await import(`${LIB}?t=${Date.now() + 1}`);
    const lockDir = join(dir, "registry.lock");
    mkdirSync(lockDir, { recursive: true });
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockDir, longAgo, longAgo); // 伪造成 60 秒前留下的死锁
    const t0 = Date.now();
    put({ key: "after-stale", role: "worker", status: "active" });
    const ms = Date.now() - t0;
    check("过期锁被抢占", readRegistry(dir).sessions["after-stale"] != null);
    check("抢占不等满超时", ms < 1500, `耗时 ${ms}ms`);
  } finally {
    delete process.env.HERDGENT_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 4. 活锁会让调用方超时而不是永久卡死 ----
{
  const dir = freshDir();
  try {
    process.env.HERDGENT_STATE_DIR = dir;
    const { put } = await import(`${LIB}?t=${Date.now() + 2}`);
    mkdirSync(join(dir, "registry.lock"), { recursive: true }); // 新鲜的锁，不会被判过期
    let code = null;
    const t0 = Date.now();
    try {
      put({ key: "blocked", role: "worker", status: "active" });
    } catch (e) {
      code = e.code;
    }
    const ms = Date.now() - t0;
    check("持锁时抛 lock_timeout", code === "lock_timeout", `实得 ${code}`);
    check("超时在 2 秒量级", ms >= 1900 && ms < 4000, `耗时 ${ms}ms`);
  } finally {
    delete process.env.HERDGENT_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
