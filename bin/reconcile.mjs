#!/usr/bin/env node
// Herdgent [[startup]] 钩子：server 启动 / live handoff 后对账。
//
// 为什么必须有这一步（实测 2026-08-05，herdr 0.8.0；要求 herdr ≥ 0.8.0）：
// 重启后布局会恢复成只跑 zsh 的 pane，但 agent 已经没了；`agent get` 会报
// agent_not_found，而 pane process-info 仍成功、pane read 为空。判据必须问 agent，
// 不能把恢复出来的 shell 当 worker 还活着。
//
// 0.7.5 的行为正好相反：agent get 留下 idle + interactive_ready 的幽灵，而 pane
// process-info 报 pane_not_found，当时的判据用 pane。那版已不支持；保留这段历史是为了
// 标明上游版本会反转可观测信号，不能把某一个口径当成不带版本边界的永久真相。
import { tryHerdr } from "../lib/herdr.mjs";
import * as registry from "../lib/registry.mjs";

// 【两阶段】探测要挨个调 herdr CLI，几十个会话就是几十次 IO。全程持锁会远超锁的
// 过期时间（10 秒）而被别人抢走，还会挡住所有 MCP server 的写入。
// 所以先无锁读快照 + 探测，最后只把结论写回去。
//
// 三种状态都要对账，各有各的漏法：
//   active   —— 常规情形，server 重启后 agent 全死了但记录还在
//   starting —— spawn 走到一半进程挂了，永远停在这个状态，还占着并发额度
//   failed   —— 【可能是误判】。agent start 的就绪等待超时会抛错，而那时 agent
//                往往已经在跑了；早先直接记 failed，于是一个活着的 agent 不在
//                任何回收路径里，静默烧额度。这里探到 agent 还在就【救回来】。
const WATCHED = new Set(["active", "starting", "failed"]);
const snapshot = registry.list().filter((s) => WATCHED.has(s.status));
if (snapshot.length === 0) {
  console.log("herdgent: no active sessions, nothing to reconcile");
  process.exit(0);
}

const verdicts = [];
let alive = 0;

for (const s of snapshot) {
  const agent = tryHerdr(["agent", "get", s.pane_id]);

  if (!agent.ok && (agent.code === "spawn_failed" || agent.code === "server_not_running")) {
    // herdr 本身不可达：不要据此宣告任何会话死亡，否则一次网络/权限抖动就抹掉全部登记。
    const reason = agent.code === "server_not_running" ? "herdr server is not running" : "herdr executable is unavailable";
    console.log(`herdgent: ${reason} (${agent.message}); reconcile aborted, registry untouched`);
    process.exit(0);
  }

  if (agent.ok) {
    alive += 1;
    // 记着 failed 但 agent 还在 = 当初判错了。救回来，否则它永远不在回收路径里。
    if (s.status === "failed") verdicts.push({ key: s.key, revive: true });
    continue;
  }

  if (agent.code === "agent_not_found") {
    verdicts.push({ key: s.key, dead: true });
  } else {
    // 没见过的错误码：不猜。留在 active 并标注，让人来看。
    verdicts.push({ key: s.key, warning: `${agent.code}: ${agent.message}` });
  }
}

const applied = registry.update((reg) => {
  let buried = 0;
  let unknown = 0;
  let revived = 0;
  for (const v of verdicts) {
    const row = reg.sessions[v.key];
    // 探测期间别的进程可能已经改过这条（比如某个 orchestrator 主动 terminate 了它）。
    // 只在它仍是我们探测时那个状态才落笔，绝不覆盖更新的状态。
    if (!row || !WATCHED.has(row.status)) continue;

    if (v.revive) {
      if (row.status !== "failed") continue;
      row.status = "active";
      row.revived_at = new Date().toISOString();
      row.revive_reason = "agent present at startup — the earlier start-timeout was a false negative";
      revived += 1;
    } else if (v.dead) {
      row.status = "dead";
      row.died_detected_at = new Date().toISOString();
      row.death_reason = "agent_not_found_at_startup";
      buried += 1;
    } else {
      row.reconcile_warning = v.warning;
      unknown += 1;
    }
  }
  return { buried, unknown, revived };
});

console.log(
  `herdgent: reconcile done — ${alive} alive, ${applied.buried} buried, ` +
    `${applied.revived} revived, ${applied.unknown} unclear`,
);
