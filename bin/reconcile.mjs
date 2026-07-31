#!/usr/bin/env node
// Herdgent [[startup]] 钩子：server 启动 / live handoff 后对账。
//
// 为什么必须有这一步（实测 2026-07-31，herdr 0.7.5）：
// 停掉 server 再起来之后，herdr 只恢复【布局】不恢复【运行时】——
//   · workspace id / custom_name / pane id / cwd 存活
//   · terminal_id 全变，pane 里的 agent 进程全被杀
//   · 但 `agent list` / `agent get` 仍然报该 agent 为 idle + interactive_ready=true，
//     而同一个 pane 在 `pane read` / `pane process-info` 下是 pane_not_found。
// 只看 agent 接口的编排层会认为有个空闲 agent 待命，然后对着尸体发指令。
// 结论：pane 侧是权威，agent 侧不是。
import { tryHerdr } from "../lib/herdr.mjs";
import * as registry from "../lib/registry.mjs";

const reg = registry.load();
const sessions = Object.values(reg.sessions);
if (sessions.length === 0) {
  console.log("herdgent: registry empty, nothing to reconcile");
  process.exit(0);
}

let alive = 0;
let buried = 0;
let unknown = 0;

for (const s of sessions) {
  if (s.status !== "active") continue;

  const pane = tryHerdr(["pane", "process-info", "--pane", s.pane_id]);
  if (!pane.ok && pane.code === "spawn_failed") {
    // herdr 本身不可达：不要据此宣告任何会话死亡，否则一次网络/权限抖动就抹掉全部登记。
    console.log(`herdgent: herdr unreachable (${pane.message}); reconcile aborted, registry untouched`);
    process.exit(0);
  }

  if (pane.ok) {
    alive += 1;
    continue;
  }

  if (pane.code === "pane_not_found") {
    s.status = "dead";
    s.died_detected_at = new Date().toISOString();
    s.death_reason = "pane_not_found_at_startup";
    buried += 1;
  } else {
    // 没见过的错误码：不猜。留在 active 并标注，让人来看。
    s.reconcile_warning = `${pane.code}: ${pane.message}`;
    unknown += 1;
  }
}

registry.save(reg);
console.log(`herdgent: reconcile done — ${alive} alive, ${buried} buried, ${unknown} unclear`);
