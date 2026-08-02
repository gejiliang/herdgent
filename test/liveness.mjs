#!/usr/bin/env node
// 并发闸的存活判定。不碰 herdr——只测「registry 里什么算占位」这套规则。
//
// 原始缺陷（FIXME #1）：没人把【agent 已经没了】的 worker 从 active 改走，
// 于是它永远算 live，静默占着并发额度，撞上限时也看不出是被谁占的。
// 修的是「缺对账」，不是「判据写错了」——判据一直是白名单，且必须是白名单。
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
//
// status 的取值域是封闭的，只有五个写入点。判据必须是【白名单】：
// 黑名单要求穷举所有死法（含历史遗留的），漏一种就多一个幽灵占着并发额度。
// 真踩过——改成黑名单后，早期版本留下的 reclaimed 记录立刻把并发数虚报成 3。
{
  seed([
    { status: "active" },
    { status: "starting" },
    { status: "terminated" }, // 显式从编排除名
    { status: "dead" }, // 对账发现 agent 没了
    { status: "failed" }, // 起都没起来
    { status: "reclaimed" }, // 【早期版本的历史状态】——不认识的一律不算 live
    { status: "something-we-never-heard-of" },
  ]);
  const c = registry.countLive("R");
  check("只有 starting / active 占位", c.inRoot === 2, `${c.inRoot} 个`);

  const live = registry.liveWorkerRows("R").map((r) => r.status).sort();
  check("认不出的状态一律不占位", JSON.stringify(live) === '["active","starting"]', live.join(","));
}

// ---- worker 跑完了仍然占位 ----
//
// 跑完不等于它没了：进程还在、pane 还占着、编排者随时能 send_to_worker 让它接着干。
// 所以 status 保持 active，herdr 报的 done/idle 写在 agent_status 那格——两件事，两格。
// 混在一格里的话，「done 了但还归这次编排管」就没法表达。
{
  seed(Array.from({ length: 6 }, () => ({ status: "active", agent_status: "done" })));
  const c = registry.countLive("R");
  check("六个跑完的 worker 仍占满闸", c.inRoot === 6, `${c.inRoot}`);
  check("agent_status 不影响占位判定", registry.liveWorkerRows("R").every((r) => r.agent_status === "done"));
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
