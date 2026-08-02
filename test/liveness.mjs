#!/usr/bin/env node
// 并发闸的存活判定。不碰 herdr——只测「registry 里什么算占位」这套规则。
//
// 修的是 FIXME(#1)：status 只在两处写入（spawn 时 active、terminate 时 terminated），
// wait 查到的 done / idle 从不写回，于是跑完但没显式 terminate 的 worker 永远算 live，
// 静默占着并发额度，撞上限时也看不出是被谁占的。
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-liveness-"));
mkdirSync(join(home, "state"), { recursive: true });
process.env.HERDGENT_HOME = home;
// 结构性隔离：这个进程必须根本连不上真 herdr。
process.env.HERDR_SOCKET_PATH = join(home, "no-such-herdr.sock");

const registry = await import(`../lib/registry.mjs?t=${Date.now()}`);

function seed(rows) {
  const sessions = {};
  for (const [i, r] of rows.entries()) {
    sessions[`k${i}`] = { key: `k${i}`, slug: `w${i}`, role: "worker", root: "R", pane_id: `p${i}`, ...r };
  }
  writeFileSync(
    join(home, "state", "registry.json"),
    JSON.stringify({ version: 2, sessions, orchestrations: { R: { root: "R", max_workers: 6 } } }),
  );
}

// ---- 什么算占位 ----
{
  seed([
    { status: "active" },
    { status: "starting" },
    { status: "done" }, // 跑完了但没除名——【仍然占位】
    { status: "idle" }, // 待命——【仍然占位】
    { status: "terminated" }, // 显式从编排除名
    { status: "dead" }, // agent 已经不在了
    { status: "failed" }, // 起都没起来
  ]);
  const c = registry.countLive("R");
  check("done / idle 仍然算占位", c.inRoot === 4, `${c.inRoot} 个（期望 active+starting+done+idle=4）`);

  // 反过来说：这三种【不】占位，否则并发闸会被幽灵记录一点点堵死。
  const gone = registry.liveWorkerRows("R").map((r) => r.status);
  check("terminated 不占位", !gone.includes("terminated"), gone.join(","));
  check("dead 不占位", !gone.includes("dead"), gone.join(","));
  check("failed 不占位", !gone.includes("failed"), gone.join(","));
}

// ---- 为什么 done 要算占位 ----
//
// 一个 done 的 worker 进程还在，占着 pane、上下文和人的注意力，编排者随时可以
// send_to_worker 让它接着干。闸拦的是「同时开着多少个会话」，不只是「同时烧多少额度」。
{
  seed(Array.from({ length: 6 }, () => ({ status: "done" })));
  const c = registry.countLive("R");
  check("六个 done 会撞上默认闸", c.inRoot >= 6, `${c.inRoot}`);
}

// ---- 归属边界 ----
{
  seed([{ status: "active" }, { status: "active", root: "OTHER" }, { status: "active", role: "orchestrator" }]);
  const c = registry.countLive("R");
  check("别的编排的 worker 不计入本编排", c.inRoot === 1, `${c.inRoot}`);
  check("但计入全局数（要报给人看）", c.global === 2, `${c.global}`);
  check("编排者自己不算 worker", registry.liveWorkerRows().every((r) => r.role === "worker"));
}

// ---- 对账把消失的 agent 标 dead ----
//
// socket 指向不存在的路径，所以每次 agent get 都失败 = 每个 worker 都被判 dead。
// 这正是要验的行为：herdr 说没有，registry 就得跟着改，而不是继续记着 active。
{
  seed([{ status: "active" }, { status: "active" }]);
  const { reconcileLive } = await import(`../lib/worker.mjs?t=${Date.now()}-2`);
  const before = registry.countLive("R").inRoot;
  const r = reconcileLive("R");
  const after = registry.countLive("R").inRoot;
  check("对账前是满的", before === 2, `${before}`);
  check("对账查了每个 worker", r.checked === 2, JSON.stringify(r));
  check("agent 不在了就标 dead", after === 0, `${after}`);
  check("dead 的记录还在（留给人查）", registry.list().length === 2, `${registry.list().length}`);
}

rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
