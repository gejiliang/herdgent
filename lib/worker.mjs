// 起一个受管会话——standalone action 与编排 worker 共用这一条路径。
//
// 归属边界是结构性的：这里【建出来】的 workspace 才进登记表，
// 其它一切 workspace 都不在射程内。绝不按 label / agent 名去全局搜索。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { herdr, herdrText, tryHerdr, waitForShell, startAgentWhenReady } from "./herdr.mjs";
import { getHarness } from "./harness/index.mjs";
import * as registry from "./registry.mjs";

// herdr 的 agent 名约束：小写字母开头，只含 [a-z0-9-_]，1–32 字符。
// ISO 时间戳（带大写 T/Z）和中文标题都会被拒，所以必须过一遍。
function slugifyName(title, fallback) {
  const s = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return /^[a-z]/.test(s) ? s : fallback;
}

// agent 名在【活着的】agent 里必须唯一。冲突时加数字后缀而不是随机串——
// 这个名字会显示在 herdr 的 Agent 侧栏里，polly 的经验是它必须一眼看出在干什么
// （好名字 auth-refactor，坏名字 claude_code / worker）。
function uniqueAgentName(base) {
  const listed = tryHerdr(["agent", "list"]);
  if (!listed.ok) return base; // 查不到就直接用，起不来时 herdr 会报错
  const taken = new Set((listed.result.agents || []).map((a) => a.agent_name || a.name).filter(Boolean));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base.slice(0, 29)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

// 启动期就 blocked 的 worker（herdr 报 agent_not_ready，lib/herdr.mjs 已接住）照常登记为 active——
// 它在等人，不是死了。留一条审计，编排层随后 wait 到 blocked 时能对上号。
function noteStartupBlocked(slug, paneId, started) {
  if (!started?.blocked_at_startup) return;
  registry.auditLog(
    `agent blocked at startup slug=${slug} pane=${paneId}; registered as active, the orchestrator must read its screen and answer`,
  );
}

// 见调用处的长注释：起 agent 回来就 done 的，基线要退一格，否则等不到。
function dispatchBaseline(agent) {
  const seq = agent?.state_change_seq ?? null;
  if (agent?.agent_status === "done" && seq != null) return seq - 1;
  return seq;
}

function newSlug() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// ---- 基础 workspace 的归属（issue #13）----
//
// herdr 的 `worktree create --cwd <repo>` 在目标仓库还没有已打开的 primary
// workspace 时，会【隐式多建一个】基础 workspace（label = 仓库名，一个空 shell），
// 并把 worktree workspace 挂在它下面成一组。run 只登记了后者，finalize 就收不到
// 前者——每次 rex 编排都在侧栏留一个空壳（2026-09-15/16 服务器日志两例）。
//
// 契约（herdr 0.9.0 逐条实测，docs/findings-2026-09-16-base-workspace.md）：
//   · `worktree list --cwd <repo>` 的 source.source_workspace_id 就是这个 repo
//     当前打开的 primary；没有已打开的 primary 时该字段【缺失】。
//   · `worktree create --workspace <id>` 用显式 source，不再隐式创建；
//     我们显式 `workspace create` 出来的 workspace 被用作 source 后即成 group primary。
//   · `workspace close <primary>` 在它还有 linked 子 workspace 时被 herdr 自己拒绝
//     （workspace_group_close_required）——并发复用的兜底由 herdr 执行，不靠我们猜。
//
// 归属证据只有两种，都写进 run / session 台账：
//   · createdByUs=true —— `workspace create` 的【响应】把这个 id 交给了本次调用；
//   · createdByUs=false —— source_workspace_id 说它在本次之前已存在：领养，绝不关闭。
// 绝不按 label 匹配、也不按「创建前后 workspace 集合差」认领——
// 并发两个创建时，差集会把别人的 base 算到自己头上。
export function resolveBaseWorkspace({ repo }) {
  const listed = herdr(["worktree", "list", "--cwd", repo]);
  const existing = listed?.source?.source_workspace_id ?? null;
  if (existing) {
    return {
      workspaceId: existing,
      createdByUs: false,
      label: null,
      expectedCwd: null,
      evidence:
        `worktree list reported source_workspace_id=${existing} — the repo's primary workspace ` +
        "pre-existed this run; adopted as the worktree source and never closed by us",
    };
  }
  // 竞态说明：另一个并发 run 可能在我们 list 与 create 之间也建了 primary。
  // 双方各自只登记【自己的 create 响应给出的 id】，互不认领，互不误删——
  // 代价只是多一个空壳，而空壳由各自的收尾按未被使用判据收回。
  const label = basename(repo) || "repo"; // 与 herdr 隐式创建时的 label 对齐：仓库目录名
  const made = herdr(["workspace", "create", "--cwd", repo, "--label", label, "--no-focus"]);
  const workspaceId = made.workspace.workspace_id;
  return {
    workspaceId,
    createdByUs: true,
    label,
    // rootPaneId 只是本次调用的临时句柄（立刻回收失败现场用），不进台账。
    rootPaneId: made.root_pane?.pane_id ?? null,
    // root_pane.cwd 是 herdr 解析过的真实路径（/tmp → /private/tmp），
    // 后面「未被使用」判据拿它跟 pane 的 foreground_cwd 比，两边同出一源。
    expectedCwd: made.root_pane?.cwd ?? repo,
    evidence:
      "worktree list showed no open primary for this repo; `workspace create` returned " +
      `workspace_id=${workspaceId} to this run — created by us, eligible for close-if-unused at cleanup`,
  };
}

// herdr 整体不可达与「这个对象没了」是两回事，同 finalize 的分类。
const HERDR_DOWN_CODES = new Set(["server_not_running", "spawn_failed"]);

const atShellPrompt = (info) => {
  const fg = info?.foreground_processes ?? [];
  return !!info?.shell_pid && fg.length > 0 && fg.every((p) => /^(-?)(zsh|bash|sh|fish)$/.test(p.name));
};

// worktree create 失败后的当场回收有个时差问题：base 才建了几十毫秒，shell 可能
// 还没到提示符，「未被使用」判据会误判 kept 把壳留下。bounded 等一下再判；
// 等不到也照常走判据（那时 kept 就是如实结论），尽力而已，不升级。
function settleFreshBaseShell(base) {
  if (!base?.rootPaneId) return;
  try {
    waitForShell(base.rootPaneId, { timeoutMs: 5000 });
  } catch {
    // 尽力而为：判据自己会决定关还是留
  }
}

// 关闭一个【登记为本次创建】的基础 workspace——但只在它仍未被使用/改动时。
// 判据全是结构性的，任一不满足或无法确定就保留（fail closed）：
//   · 恰好 1 tab / 1 pane，label 没被改，workspace 与 pane 都没有 agent 活动
//   · 唯一 pane 的前台 cwd 仍是创建时记录的目录（人 cd 走了就算用过）
//   · 前台进程就是 shell 本身（停在提示符，没跑别的东西）
// 最后的关闭由 herdr 的 group 守卫兜底：还有 linked 子 workspace 就拒关——
// 那是别的 run 的容器还挂在上面，保留并如实记录，不升级成失败。
//
// 返回 { status, detail }：closed | already_gone | kept | failed | aborted。
// kept 是【刻意的安全结果】不是失败；failed 可重试；aborted 是 herdr 整体不可达。
export function closeBaseWorkspaceIfUnused(base) {
  const id = base?.workspaceId;
  if (!id) return { status: "failed", detail: "no base workspace id on record" };

  const ws = tryHerdr(["workspace", "get", id]);
  if (!ws.ok) {
    if (HERDR_DOWN_CODES.has(ws.code)) return { status: "aborted", detail: `${ws.code}: ${ws.message}` };
    if (ws.code === "workspace_not_found") return { status: "already_gone", detail: "already gone" };
    return { status: "failed", detail: `cannot inspect workspace: ${ws.code}: ${ws.message}` };
  }
  const info = ws.result.workspace ?? {};
  if (base.label != null && info.label !== base.label) {
    return { status: "kept", detail: `label changed '${base.label}' → '${info.label}' — someone touched it, not ours to close` };
  }
  if ((info.tab_count ?? 0) !== 1 || (info.pane_count ?? 0) !== 1) {
    return {
      status: "kept",
      detail: `tab/pane count is ${info.tab_count}/${info.pane_count}, not the 1/1 we created — someone used it`,
    };
  }
  if ((info.agent_status ?? "unknown") !== "unknown") {
    return { status: "kept", detail: `workspace agent_status=${info.agent_status} — an agent is attached` };
  }

  const panes = tryHerdr(["pane", "list", "--workspace", id]);
  if (!panes.ok) {
    if (HERDR_DOWN_CODES.has(panes.code)) return { status: "aborted", detail: `${panes.code}: ${panes.message}` };
    return { status: "failed", detail: `cannot list panes: ${panes.code}: ${panes.message}` };
  }
  const list = panes.result.panes ?? [];
  if (list.length !== 1) return { status: "kept", detail: `${list.length} panes now, not the 1 we created` };
  const pane = list[0];
  //  cwd 没法确定时按「用过」处理——这一条本来就是「证明没动过」，证明不了就留。
  if (!base.expectedCwd || pane.foreground_cwd !== base.expectedCwd) {
    return {
      status: "kept",
      detail: `pane cwd is ${pane.foreground_cwd ?? "unknown"}, expected ${base.expectedCwd ?? "unknown"} — cannot prove it is untouched`,
    };
  }
  if ((pane.agent_status ?? "unknown") !== "unknown") {
    return { status: "kept", detail: `pane agent_status=${pane.agent_status}` };
  }

  const proc = tryHerdr(["pane", "process-info", "--pane", pane.pane_id]);
  if (!proc.ok) {
    if (HERDR_DOWN_CODES.has(proc.code)) return { status: "aborted", detail: `${proc.code}: ${proc.message}` };
    return { status: "failed", detail: `cannot inspect foreground process: ${proc.code}: ${proc.message}` };
  }
  if (!atShellPrompt(proc.result.process_info)) {
    const fg = proc.result.process_info?.foreground_processes ?? [];
    return { status: "kept", detail: `foreground is ${fg.map((p) => p.name).join(",") || "none"}, not a bare shell prompt` };
  }

  const close = tryHerdr(["workspace", "close", id]);
  if (close.ok) return { status: "closed", detail: "closed; it was created by this run and still unused" };
  if (close.code === "workspace_group_close_required") {
    return {
      status: "kept",
      detail: "herdr refused: linked worktree workspaces remain (another run adopted it as source) — left in place",
    };
  }
  if (close.code === "workspace_not_found") return { status: "already_gone", detail: "already gone" };
  if (HERDR_DOWN_CODES.has(close.code)) return { status: "aborted", detail: `${close.code}: ${close.message}` };
  return { status: "failed", detail: `${close.code}: ${close.message}` };
}

// ---- 预建 stage root pane 的「未被使用」证明（issue #14）----
//
// run_plan 把整个计划的 tab 一次建齐，每个 tab 自带一个 root pane（空 shell）。
// 计划提前停止（超时 / blocked / 起不来）时，没轮到的环节从没派过 worker——
// 它的 root pane 没有 worker 行，但【是本 run 创建回执里登记过的对象】
//（stages[tab].root_pane_id）。复用它（spawn_worker 追加）或收尾它（finalize
// 归属扫描）之前，必须先证明它至今仍未被使用——判据与 closeBaseWorkspaceIfUnused
// 同源，全是结构性的：
//   · pane 上没有 agent（list 行 agent_status 与 agent get 双重确认）
//   · 前台就是 shell 提示符（人在里面跑了别的东西就不算）
//   · 记录了创建时 cwd 的，当前 foreground_cwd 必须仍是它（人 cd 走了就算用过；
//     没记录基准的跳过这条比对，只靠前两条）
// 任一读不出来或证明不了，返回的都不是 unused——fail closed，绝不认领陌生 pane。
//
// 返回 { status, detail }：unused | used | failed | aborted。
//   used 是【刻意的安全结论】（它被人动过，不是我们那个空壳）；
//   failed 是读出问题（可重试）；aborted 是 herdr 整体不可达。
export function provePaneUnused({ paneId, expectedCwd = null, listRow = null, settleMs = 1000 }) {
  let row = listRow;
  if (!row) {
    const got = tryHerdr(["pane", "get", paneId]);
    if (!got.ok) {
      if (HERDR_DOWN_CODES.has(got.code)) return { status: "aborted", detail: `${got.code}: ${got.message}` };
      return { status: "failed", detail: `cannot inspect pane: ${got.code}: ${got.message}` };
    }
    row = got.result.pane ?? {};
  }
  if ((row.agent_status ?? "unknown") !== "unknown") {
    return { status: "used", detail: `pane agent_status=${row.agent_status} — an agent is attached` };
  }
  const agent = tryHerdr(["agent", "get", paneId]);
  if (agent.ok) {
    return { status: "used", detail: `agent '${agent.result.agent?.agent_name ?? "?"}' is running in it` };
  }
  if (HERDR_DOWN_CODES.has(agent.code)) return { status: "aborted", detail: `${agent.code}: ${agent.message}` };
  if (agent.code !== "agent_not_found") {
    return { status: "failed", detail: `cannot check for an agent: ${agent.code}: ${agent.message}` };
  }
  if (expectedCwd != null && row.foreground_cwd !== expectedCwd) {
    return {
      status: "used",
      detail: `pane cwd is ${row.foreground_cwd ?? "unknown"}, expected ${expectedCwd} — someone moved it`,
    };
  }
  // shell 到提示符前有一小段启动窗口（0.9.0 实测 zsh 会先跑 locale 之类的子进程，
  // 前台不是纯 shell）——单发一拍会把【还没就绪】误判成【被人在用】。bounded 等一拍；
  // 等不到就是证明不了空闲，fail closed 按 used 处理。
  const deadline = Date.now() + settleMs;
  for (;;) {
    const proc = tryHerdr(["pane", "process-info", "--pane", paneId]);
    if (!proc.ok) {
      if (HERDR_DOWN_CODES.has(proc.code)) return { status: "aborted", detail: `${proc.code}: ${proc.message}` };
      return { status: "failed", detail: `cannot inspect foreground process: ${proc.code}: ${proc.message}` };
    }
    if (atShellPrompt(proc.result.process_info)) {
      return { status: "unused", detail: "bare shell at prompt, no agent attached, cwd untouched" };
    }
    if (Date.now() >= deadline) {
      const fg = proc.result.process_info?.foreground_processes ?? [];
      return { status: "used", detail: `foreground is ${fg.map((p) => p.name).join(",") || "none"}, not a bare shell prompt` };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

/**
 * 一次编排 = 一个 worktree workspace，挂在父 repo 下。
 * 环节是 tab，环节内的并行任务是 pane —— 布局与用户手工建 worktree 时一致。
 *
 * 不给 branch 时 herdr 自动起名（worktree/green-stone-0eb3 那种），
 * label 才是人看的任务名。
 */
export function createOrchestrationSpace({ repo, label, branch = null }) {
  // 先落定基础 workspace（见上方 issue #13 的长注释）：显式 source，
  // herdr 就不会再隐式建一个无人登记的空壳。
  const base = resolveBaseWorkspace({ repo });
  const args = ["worktree", "create", "--workspace", base.workspaceId, "--label", label, "--no-focus"];
  if (branch) args.push("--branch", branch);
  let ws;
  try {
    ws = herdr(args);
  } catch (e) {
    // worktree 没建成：刚建的基础 workspace 是我们几秒前建的空壳，当场收回。
    // 并发者若已把它当 source，herdr 的 group 守卫会拒关，那就如实记 kept。
    if (base.createdByUs) {
      settleFreshBaseShell(base);
      const back = closeBaseWorkspaceIfUnused(base);
      throw Object.assign(new Error(`${e.message} (base workspace ${base.workspaceId}: ${back.status})`), {
        code: e.code || "worktree_create_failed",
      });
    }
    throw e;
  }
  const checkoutPath = ws.workspace?.worktree?.checkout_path ?? null;

  // worktree create 的返回里【没有 branch 字段】（只有 checkout_path / repo_key 那些），
  // 而不给 --branch 时分支名是 herdr 自动起的。直接问 git，别从路径反推——
  // 路径把 worktree/green-cloud-ee8b 写成了 worktree-green-cloud-ee8b，斜杠没了。
  let resolved = branch;
  if (!resolved && checkoutPath) {
    try {
      resolved = execFileSync("git", ["-C", checkoutPath, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {
      resolved = null;
    }
  }

  return {
    workspaceId: ws.workspace.workspace_id,
    rootTabId: ws.tab?.tab_id ?? null,
    rootPaneId: ws.root_pane.pane_id,
    checkoutPath,
    branch: resolved || null,
    baseWorkspace: base,
  };
}

// 一个环节一个 tab。第一个环节复用 worktree 自带的那个 tab（重命名即可），
// 否则会白白多出一个空 tab —— 用户手工建的布局里也没有那种东西。
//
// rootPaneCwd 是 root pane 的【创建回执 cwd】（issue #14）：herdr 解析过的真实路径，
// 与日后 pane list 的 foreground_cwd 同出一源——provePaneUnused 拿它证明
// 「这个预建 root 至今没被人动过」。cwd 绝不能拿 run 的 checkout_path 当基准，
// 那个没解析过（/tmp vs /private/tmp，见 findings-2026-09-16-base-workspace.md）。
export function openStageTab({ workspaceId, label, reuseTabId = null }) {
  if (reuseTabId) {
    tryHerdr(["tab", "rename", reuseTabId, label]);
    const panes = tryHerdr(["pane", "list", "--workspace", workspaceId]);
    const first = panes.ok
      ? (panes.result.panes || []).find((x) => x.tab_id === reuseTabId)
      : null;
    if (first) {
      return { tabId: reuseTabId, rootPaneId: first.pane_id, rootPaneCwd: first.foreground_cwd ?? first.cwd ?? null };
    }
  }
  const t = herdr(["tab", "create", "--workspace", workspaceId, "--label", label, "--no-focus"]);
  // tab create 的 root_pane 带 cwd / foreground_cwd（0.9.0 实测）。
  return { tabId: t.tab.tab_id, rootPaneId: t.root_pane.pane_id, rootPaneCwd: t.root_pane.cwd ?? t.root_pane.foreground_cwd ?? null };
}

// 环节的状态标在 tab 名字末尾——人扫一眼侧栏就知道跑到哪了，不用点进去看。
// 改名是 herdr 的普通操作，失败也不该影响编排本身。
//
// pending 存在的理由：整个计划的 tab 是【一次建齐】的，没轮到的那些必须看得出
// 「还没开始」，否则空 tab 跟跑挂了的 tab 长得一样。
const STAGE_MARK = { pending: "☐", running: "⋯", done: "✓", blocked: "⚠", failed: "✗" };

export function setStageStatus(tabId, baseLabel, status) {
  const mark = STAGE_MARK[status] ?? "";
  tryHerdr(["tab", "rename", tabId, mark ? `${baseLabel} ${mark}` : baseLabel]);
}

// 状态是【可回退的】：review 打回 impl 时，impl 那个 tab 必须从 ✓ 退回 ⋯，
// 否则侧栏显示的是「全都完成了」，而实际上有人正在返工。
// 回退要拿得到 tab 的 baseLabel，所以那个标签存在 registry 的 stages 表里，
// 不是 run_plan 的局部变量——run_plan 一返回，局部变量就没了。
export function stageBaseLabel(root, tabId) {
  return registry.findStageByTab(root, tabId)?.stage?.label ?? null;
}

// worker 拿到新任务时把它所在的环节退回「进行中」。
// 挂在 send_to_worker 上而不是给编排者一个「改状态」的动词：状态该由
// 【实际发生的事】驱动，靠编排者记得去标就一定会漏——GG 那次返工正是这么漏的。
export function markStageRunning(root, tabId) {
  if (!tabId) return null;
  // 读-改-写必须在一把锁里：并行 worker 可能同时回报，分开读写会丢更新。
  // 环节标签存在它所属 run 的 stages 里（旧数据在 orchestration 平级），
  // 两处都要找——run_plan 一返回局部变量就没了，这是唯一的来处。
  const label = registry.update((reg) => {
    const orc = reg.orchestrations[root];
    if (!orc) return null;
    for (const run of Object.values(orc.runs || {})) {
      const stage = run.stages?.[tabId];
      if (stage?.label) {
        stage.status = "running";
        return stage.label;
      }
    }
    const legacy = orc.stages?.[tabId];
    if (!legacy?.label) return null;
    legacy.status = "running";
    return legacy.label;
  });
  if (label) setStageStatus(tabId, label, "running");
  return label;
}

/**
 * 跟 herdr 对一次账：registry 里记着还活着的 worker，逐个确认它的 agent 是否真在。
 * agent 不在了的标 dead，顺手把 herdr 报的实时状态写回去。
 *
 * 【为什么必须现查】registry 的 status 是缓存，真相在 herdr。以前 status 只在
 * 两处写入（spawn 时 active、terminate 时 terminated），wait 查到的 done/idle
 * 从不写回；worker 跑完但没显式 terminate 的话就永远算 live，静默占着并发额度，
 * 撞上限时还看不出是被谁占的。写回只能治「记录过期」，治不了「agent 早就没了
 * 而记录还在」——那种只有现查才发现，所以对账放在【每次 spawn 之前】。
 *
 * 代价是每次 spawn 多发 N 次 herdr 查询，N 是本编排还活着的 worker 数（通常 ≤6）。
 * 换来的是并发闸永远不会被幽灵记录堵死。
 */
export function reconcileLive(root = null) {
  const rows = registry.liveWorkerRows(root);
  const seen = [];
  for (const row of rows) {
    if (!row.pane_id) continue;
    const r = tryHerdr(["agent", "get", row.pane_id]);
    if (!r.ok && (r.code === "spawn_failed" || r.code === "server_not_running")) {
      // 这是 herdr 整体不可达，不是这条 worker 死了。若继续写回 dead，
      // 一次 server 重启就会把整张 registry 误判为空。
      return { checked: rows.length, changed: 0, aborted: true, code: r.code };
    }
    if (!r.ok) {
      // agent 不在了（pane 关了 / herdr 重启了 / 从没起来）。
      seen.push({ slug: row.slug, was: row.status, now: "dead" });
      continue;
    }
    const status = r.result.agent?.agent_status ?? null;
    if (status && status !== row.agent_status) seen.push({ slug: row.slug, was: row.status, now: status });
  }
  if (!seen.length) return { checked: rows.length, changed: 0 };

  registry.update((reg) => {
    for (const s of seen) {
      const row = Object.values(reg.sessions).find((x) => x.slug === s.slug);
      if (!row) continue;
      if (s.now === "dead") {
        row.status = "dead";
        row.died_at = new Date().toISOString();
      } else {
        // herdr 报的实时状态单独存一格：status 是【归属】（还在不在这次编排里），
        // agent_status 是【活儿】（在跑还是待命）。混在一格里，
        // 「done 了但还在编排里」就没法表达。
        row.agent_status = s.now;
      }
    }
  });
  return { checked: rows.length, changed: seen.length, details: seen };
}

/**
 * 起 agent 时那条初始 prompt。
 *
 * ⚠️ 【长任务绝不能进 argv】。herdr 的 `agent start` 把整条命令打进 pane 的
 * 命令行，超长会被【截断】——而截断的命令引号不闭合，shell 就一直等着，
 * agent 从没启动，herdr 等到 --timeout 用完报「timed out waiting for agent
 * startup」。看起来像「起不来」，实际是命令根本没提交。
 *
 * 实测（2026-08-02，herdr 0.7.5）：一条 3112 字节的 pi 命令被砍在 1023 字节处，
 * pane 的前台进程仍是 zsh，命令行上停着半条命令。同一批 worker 里 927 字节的
 * 任务成功、2536 字节的失败；早先记成「pi 起不来」的那两个 2546 字节任务，
 * 根因也是这个，不是启动慢。
 *
 * 所以超过阈值就【只传路径】：任务本来就已经写进 task.md 了，argv 里再塞一份
 * 纯属多余。附带的好处是任务不必压平——worker 读到的是【原始格式】，
 * 换行、列表、代码块都在，比压成一行的版本好读得多。
 *
 * 阈值取得保守（1200 字节，含 prompt 与 flags 之前）：确切上限没必要摸清，
 * 它可能随 herdr 版本变，而走文件这条路永远是对的。
 */
const ARGV_TASK_LIMIT = 1200;

// agent start 正常返回后，20 秒已足够让首轮从 idle 变成可观测状态；超过这个窗口
// 仍没迹象就不是「慢」，继续交给 30 分钟 wait 会把吞 prompt 伪装成成功。
const OPENING_START_TIMEOUT_MS = 20_000;
const OPENING_START_INTERVAL_MS = 250;

export function buildOpeningPrompt({ task, flatTask, taskPath, adapter, prompt }) {
  // 不支持 system prompt 的 harness（codex）降级：把 profile 的提示词
  // 前置到用户消息里。位置靠前，让它先于任务被读到。
  const flatPrompt =
    prompt && !adapter.supportsSystemPrompt
      ? String(prompt).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim()
      : null;

  const body = flatPrompt ? `${flatPrompt} 现在执行：${flatTask}` : flatTask;
  if (Buffer.byteLength(body, "utf8") <= ARGV_TASK_LIMIT) {
    return body === String(task).trim()
      ? body
      : `${body} [The original task text, with its formatting intact, is at ${taskPath} — read it if the flattened version above is ambiguous.]`;
  }

  // 长任务：argv 里只留一句话加一个路径。
  const head = flatPrompt ? `${flatPrompt} ` : "";
  return (
    `${head}Your task is written in ${taskPath}. Read that file first — it is the complete and ` +
    `authoritative instruction, in its original formatting. Nothing else was said to you. ` +
    `Carry it out, then report back.`
  );
}

// 终止符由 adapter 声明，worker 不知道哪家 CLI 的 flag 会吞位置参数。
export function buildHarnessCommandArgs(adapter, harnessArgs, openingPrompt) {
  return [...harnessArgs, ...(adapter.argvTerminator ? [adapter.argvTerminator] : []), openingPrompt];
}

// 环节内的第 2..N 个并行任务。方向交替，免得一列压得太扁。
export function splitForParallel(paneId, index) {
  const dir = index % 2 === 1 ? "down" : "right";
  const r = herdr(["pane", "split", paneId, "--direction", dir]);
  return r.pane.pane_id;
}

/**
 * 在【已经存在】的 pane 里起一个 harness 会话。
 * 容器（workspace / tab / pane）由调用方管理，这里不建也不回收——
 * 一个编排容器里有多个 worker，某一个起不来不该把整个容器收掉。
 */
export function startAgentInPane({
  paneId,
  cwd,
  task,
  harness = "claude",
  role = "worker",
  root = null,
  parent = null,
  runId = null,
  stepId = null,
  title = null,
  purpose = null,
  branch = null,
  repo = null,
  workspaceId = null,
  tabId = null,
  yolo = false,
  model = null,
  effort = null,
  readOnly = false,
  prompt = null,
}) {
  const adapter = getHarness(harness);
  if (!task || !String(task).trim()) {
    throw Object.assign(new Error("task (initial prompt) is required"), { code: "task_required" });
  }

  const slug = newSlug();
  const pendingKey = `pending:${slug}`;
  const label = title ? slugifyName(title, `herdgent-${slug}`) : `herdgent-${slug}`;
  const flatTask = String(task).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();

  waitForShell(paneId);

  const sessionDir = join(registry.stateDir(), "sessions", slug);
  mkdirSync(sessionDir, { recursive: true });
  const taskPath = join(sessionDir, "task.md");
  writeFileSync(taskPath, `${task}\n`);

  let settingsPath = null;
  if (adapter.needsHook) {
    settingsPath = join(sessionDir, "settings.json");
    const hookPath = join(import.meta.dirname, "..", "bin", "hook-claude.mjs");
    const hookCmd = `${process.execPath} ${hookPath} ${pendingKey} --state-dir ${registry.stateDir()}`;
    writeFileSync(
      settingsPath,
      JSON.stringify(
        { hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCmd }] }] } },
        null,
        2,
      ),
    );
  }

  // 登记先于起 agent：SessionStart 钩子在 agent start 执行期间就会回调。
  registry.put({
    key: pendingKey,
    slug,
    role,
    root,
    parent,
    run_id: runId,
    step_id: stepId,
    title,
    purpose,
    harness,
    agent_name: label,
    workspace_label: title || label,
    workspace_id: workspaceId,
    tab_id: tabId,
    pane_id: paneId,
    worktree_branch: branch,
    repo,
    cwd,
    task,
    yolo,
    model,
    effort,
    prompt,
    read_only: readOnly,
    status: "starting",
    created_at: new Date().toISOString(),
    settings_path: settingsPath,
  });

  try {
    const agentName = uniqueAgentName(label);
    const harnessArgs = adapter.buildArgs({
      cwd,
      settingsPath,
      yolo,
      model,
      effort,
      readOnly,
      prompt: adapter.supportsSystemPrompt ? prompt : null,
      sessionDir: join(sessionDir, "harness-sessions"),
    });

    const openingPrompt = buildOpeningPrompt({ task, flatTask, taskPath, adapter, prompt });

    const started = startAgentWhenReady([
      "agent", "start", agentName,
      "--kind", harness,
      "--pane", paneId,
      // herdr 自带的就绪等待，默认 30s、上限 300s。并发起一批 worker 时
      // 30s 会卡在临界点上（pi 尤其），而超时的代价不是「慢一点」——
      // 是 agent 已经在跑却被判成启动失败，然后没人回收。给足时间更便宜。
      "--timeout", "180000",
      "--", ...buildHarnessCommandArgs(adapter, harnessArgs, openingPrompt),
    ]);
    noteStartupBlocked(slug, paneId, started);

    const entry = registry.update((reg) => {
      const prev = Object.values(reg.sessions).find((s) => s.slug === slug);
      const key = prev?.key ?? pendingKey;
      reg.sessions[key] = {
        ...(prev ?? {}),
        key,
        agent_name: agentName,
        status: "active",
        dispatch_seq: dispatchBaseline(started.agent),
        // 新起的 worker，transcript 从零开始——答一句就算这一轮有产出。
        dispatch_turns: 0,
        herdr_reported_session_id: started.agent?.agent_session?.value ?? null,
        harness_session_kind: started.agent?.agent_session?.kind ?? prev?.harness_session_kind ?? null,
        harness_session_id: prev?.harness_session_id ?? started.agent?.agent_session?.value ?? null,
      };
      return reg.sessions[key];
    });
    confirmOpeningStarted({
      slug,
      paneId,
      harness,
      openingPrompt,
      baseline: entry.dispatch_seq,
      initialAgent: started.agent,
    });
    return entry;
  } catch (e) {
    registry.update((reg) => {
      const entry = Object.values(reg.sessions).find((s) => s.slug === slug);
      if (entry) {
        entry.status = "failed";
        entry.failure = `${e.code || "?"}: ${e.message}`;
      }
    });
    throw e;
  }
}

/**
 * 建 workspace（或 worktree workspace）并在其中起一个 harness 会话。
 *
 * branch 给了就走 worktree：实测 checkout 落在 ~/.herdr/worktrees/<repo>/<branch>，
 * 不在项目目录里，且 herdr 会自动建出父 repo workspace 并把它分组在下面。
 */
export function startManagedSession({
  cwd,
  task,
  harness = "claude",
  role = "standalone",
  root = null,
  parent = null,
  title = null,
  purpose = null,
  branch = null,
  yolo = false,
  model = null,
  effort = null,
  readOnly = false,
  prompt = null,
}) {
  const adapter = getHarness(harness);

  if (!task || !String(task).trim()) {
    // 裸跑 claude 会落在会话面板首页：herdr 观测不到任何状态变化，而提示词又确实会被提交。
    // 编排层会以为什么都没发生，实际有会话在无人看管地跑。
    throw Object.assign(new Error("task (initial prompt) is required"), { code: "task_required" });
  }

  const slug = newSlug();
  const pendingKey = `pending:${slug}`;
  const label = title ? slugifyName(title, `herdgent-${slug}`) : `herdgent-${slug}`;
  // 展示名与 agent id 是两回事：agent 名受 herdr 的 [a-z0-9-_] 约束必须过 slugify，
  // 而 workspace label 是给人看的——中文标题必须原样上去，不能拿 ASCII slug 顶包
  // （踩过：「rex · 思考能力复核」在侧栏显示成 rex，agent 约束泄露到了展示层）。
  const displayLabel = title || label;

  // herdr 拒绝【含换行】的 agent 参数（invalid_agent_argument: "cannot be encoded
  // safely for the target shell"）。实测只有换行有问题——中文、引号、反引号、$ 都能过。
  // 编排者写的任务几乎必然是多行的，所以这一步是必需的，不是防御性编程。
  // 原文另存一份，压缩损失了格式时 worker 可以自己去读。
  const flatTask = String(task).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();

  // 1) 建容器
  let ws;
  let checkoutPath = null;
  let baseWorkspace = null;
  if (branch) {
    // 与编排路径同一个规矩（issue #13）：显式 source，不隐式创建无登记的空壳。
    baseWorkspace = resolveBaseWorkspace({ repo: cwd });
    try {
      ws = herdr([
        "worktree", "create",
        "--workspace", baseWorkspace.workspaceId,
        "--branch", branch,
        "--label", displayLabel,
        "--no-focus",
      ]);
    } catch (e) {
      if (baseWorkspace.createdByUs) {
        settleFreshBaseShell(baseWorkspace);
        const back = closeBaseWorkspaceIfUnused(baseWorkspace);
        throw Object.assign(new Error(`${e.message} (base workspace ${baseWorkspace.workspaceId}: ${back.status})`), {
          code: e.code || "worktree_create_failed",
        });
      }
      throw e;
    }
    checkoutPath = ws.workspace?.worktree?.checkout_path ?? null;
  } else {
    ws = herdr(["workspace", "create", "--cwd", cwd, "--label", displayLabel, "--no-focus"]);
  }

  const workspaceId = ws.workspace.workspace_id;
  const paneId = ws.root_pane.pane_id;
  const workCwd = checkoutPath || cwd;

  const reclaim = () => {
    const r = branch
      ? tryHerdr(["worktree", "remove", "--workspace", workspaceId, "--force"])
      : tryHerdr(["workspace", "close", workspaceId]);
    let note = r.ok ? "reclaimed" : `LEAKED ${workspaceId} (${r.code})`;
    // 附带的基础 workspace：只收【本次创建】的，且仍要过未被使用判据。
    // 启动失败的这次会话从没碰过它，但并发的另一个 run 可能刚把它当 source——
    // 那种情况 herdr 的 group 守卫会拒关，如实记 kept，不是误清。
    if (branch && baseWorkspace?.createdByUs) {
      const back = closeBaseWorkspaceIfUnused(baseWorkspace);
      note += `, base ${baseWorkspace.workspaceId} ${back.status}`;
    }
    return note;
  };

  try {
    // 2) 等 shell 到提示符。workspace create 返回时它还没到，紧接着 agent start
    //    会报 agent_pane_busy；手工分步操作感觉不到，脚本连发必踩。
    waitForShell(paneId);

    // 3) 控制面经启动 argv 注入。具体注入什么由 harness 适配层决定——
    //    claude 走 --settings（实测是【合并】语义，我们的 SessionStart 与 herdr 自己的
    //    同时生效），codex 走 -c 且必须注入目录信任，否则每个 worktree 都会卡在
    //    「Do you trust this directory?」上，而 herdr 把那个界面报成 idle 不是 blocked。
    const sessionDir = join(registry.stateDir(), "sessions", slug);
    mkdirSync(sessionDir, { recursive: true });

    // 原文落一份：argv 里的是压平版本，格式（列表、代码块）会丢。
    const taskPath = join(sessionDir, "task.md");
    writeFileSync(taskPath, `${task}\n`);

    // 只有需要钩子的 harness 才写 settings。codex 不需要——herdr 的 codex integration
    // 已经报告 session id，而它的钩子配置是【全局共享】的 ~/.codex/hooks.json，不能碰。
    let settingsPath = null;
    if (adapter.needsHook) {
      settingsPath = join(sessionDir, "settings.json");
      const hookPath = join(import.meta.dirname, "..", "bin", "hook-claude.mjs");
      const hookCmd = `${process.execPath} ${hookPath} ${pendingKey} --state-dir ${registry.stateDir()}`;
      writeFileSync(
        settingsPath,
        JSON.stringify(
          { hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCmd }] }] } },
          null,
          2,
        ),
      );
    }

    // 4) 登记必须【先于】起 agent：SessionStart 钩子在 agent start 执行期间就会回调，
    //    那时登记表里没有这条记录的话，钩子只能记一条 miss，session id 就丢了。
    registry.put({
      key: pendingKey,
      slug,
      role,
      root,
      parent,
      title,
      purpose,
      harness,
      agent_name: label,
      workspace_label: displayLabel,
      // 下面这些是【当时的】句柄，重启后会变，仅用于本次寻址，不作主键
      workspace_id: workspaceId,
      pane_id: paneId,
      worktree_branch: branch,
      checkout_path: checkoutPath,
      // 附带基础 workspace 的归属证据（issue #13）：只登记，reclaim 时凭它判断收不收。
      base_workspace: baseWorkspace
        ? {
            workspace_id: baseWorkspace.workspaceId,
            created_by_run: baseWorkspace.createdByUs,
            label: baseWorkspace.label,
            expected_cwd: baseWorkspace.expectedCwd,
            evidence: baseWorkspace.evidence,
          }
        : null,
      repo: cwd, // 原仓库路径，回收分支时要在这里执行 git
      cwd: workCwd,
      task,
      yolo,
      model,
      effort,
      prompt,
      read_only: readOnly,
      status: "starting",
      created_at: new Date().toISOString(),
      settings_path: settingsPath,
    });

    // 5) 起 agent。flag 一律排在位置参数之前——初始 prompt 必须是最后一个 argv。
    const agentName = uniqueAgentName(label);
    const harnessArgs = adapter.buildArgs({
      cwd: workCwd,
      settingsPath,
      yolo,
      model,
      effort,
      readOnly,
      prompt: adapter.supportsSystemPrompt ? prompt : null,
      sessionDir: join(sessionDir, "harness-sessions"),
    });

    const openingPrompt = buildOpeningPrompt({ task, flatTask, taskPath, adapter, prompt });

    const started = startAgentWhenReady([
      "agent", "start", agentName,
      "--kind", harness,
      "--pane", paneId,
      // herdr 自带的就绪等待，默认 30s、上限 300s。并发起一批 worker 时
      // 30s 会卡在临界点上（pi 尤其），而超时的代价不是「慢一点」——
      // 是 agent 已经在跑却被判成启动失败，然后没人回收。给足时间更便宜。
      "--timeout", "180000",
      "--", ...buildHarnessCommandArgs(adapter, harnessArgs, openingPrompt),
    ]);
    noteStartupBlocked(slug, paneId, started);

    // 6) 钩子可能已经把 pending: 键换成了 claude:<uuid>，所以按 slug 找回自己那条，不按键。
    const entry = registry.update((reg) => {
      const prev = Object.values(reg.sessions).find((s) => s.slug === slug);
      const key = prev?.key ?? pendingKey;
      reg.sessions[key] = {
        ...(prev ?? {}),
        key,
        agent_name: agentName,
        status: "active",
        // 派活基线：只有严格【大于】它的终态才算「这一轮结束了」。不记这个，
        // 等待方会拿到上一轮的终态立即返回（findings 第二节第 3 条）。
        //
        // 但起 agent 时的基线要看它【回来时是什么状态】，各家不同：
        //   · claude / codex 返回时是 idle —— 初始任务还没跑，用当时的 seq 当基线，
        //     等它涨上去才算完成。
        //   · pi 返回时往往已经是 done —— 初始任务在 agent start 返回前就跑完了，
        //     再用当时的 seq 当基线就是在等一个【永远不会再来】的变化，wait 直接挂死。
        // herdr 的语义分得很清：done = 完成且未被查看（有新产出），
        // idle = 完成或等待且已被看过（没有新产出）。所以只对 done 回退一格。
        dispatch_seq: dispatchBaseline(started.agent),
        // 新起的 worker，transcript 从零开始——答一句就算这一轮有产出。
        dispatch_turns: 0,
        // herdr 侧也报告了 harness session 引用；kind 决定 value 是 id 还是文件路径
        // （pi 报 path，claude/codex 报 id），适配层据此定位 transcript。
        herdr_reported_session_id: started.agent?.agent_session?.value ?? null,
        harness_session_kind: started.agent?.agent_session?.kind ?? prev?.harness_session_kind ?? null,
        harness_session_id: prev?.harness_session_id ?? started.agent?.agent_session?.value ?? null,
      };
      return reg.sessions[key];
    });
    confirmOpeningStarted({
      slug,
      paneId,
      harness,
      openingPrompt,
      baseline: entry.dispatch_seq,
      initialAgent: started.agent,
    });
    return entry;
  } catch (e) {
    // 起不来就把自己建的容器收回去，否则每次失败都在用户界面里留一个空壳。
    const note = reclaim();
    registry.update((reg) => {
      const entry = Object.values(reg.sessions).find((s) => s.slug === slug);
      if (entry) {
        entry.status = "failed";
        entry.failure = `${e.code || "?"}: ${e.message}`;
      }
    });
    throw Object.assign(new Error(`${e.message} (${note})`), { code: e.code || "start_failed" });
  }
}

// 按 slug 查。slug 是 herdgent 自己生成的稳定句柄——registry 的 key 会被
// SessionStart 钩子从 pending:<slug> 改写成 claude:<uuid>，slug 不会变。
export function findWorker(slug) {
  return Object.values(registry.load().sessions).find((s) => s.slug === slug) || null;
}

// 拿 harness 侧的 session id，没有就现问 herdr 一次并补进登记表。
//
// 不在 spawn 时等：实测 codex 起来十几秒后 herdr 才报告 session id，
// 而 spawn 本身只要 3.5 秒——为此阻塞每一次派活不划算。反正读结果之前
// 一定先 wait 过，那时早就有了。
export function ensureSessionId(slug) {
  const w = findWorker(slug);
  if (!w) return null;
  if (w.harness_session_id) return w.harness_session_id;

  const r = tryHerdr(["agent", "get", w.pane_id]);
  const ref = r.ok ? r.result.agent?.agent_session : null;
  if (!ref?.value) return null;

  registry.update((reg) => {
    const row = Object.values(reg.sessions).find((s) => s.slug === slug);
    if (row) {
      row.harness_session_id = ref.value;
      row.harness_session_kind = ref.kind ?? null;
      row.session_id_source = "herdr_report";
    }
  });
  return ref.value;
}

// 定位并解析 worker 的产出。路径来源按 harness 分：claude 靠钩子回填，
// codex 靠 session uuid 在文件名里找。
function noOutputYet(slug, path) {
  return Object.assign(
    new Error(
      `no output for '${slug}' yet: transcript ${path} does not exist ` +
        "(if this agent never received a prompt, this file will not exist)",
    ),
    { code: "no_output_yet" },
  );
}

export function readWorkerResult(slug, opts = {}) {
  const w = findWorker(slug);
  if (!w) throw Object.assign(new Error(`no worker '${slug}'`), { code: "worker_not_found" });

  const adapter = getHarness(w.harness || "claude");
  const sessionId = w.harness_session_id || ensureSessionId(slug);
  const path = adapter.findTranscript(sessionId, w);

  if (!path) {
    // 刚起的 worker 就是这样，不是错误——重试即可。
    throw Object.assign(
      new Error(
        `no transcript for '${slug}' yet` +
          (sessionId ? "" : " (harness session id not reported by herdr yet)"),
      ),
      { code: "transcript_not_ready" },
    );
  }

  if (!existsSync(path)) throw noOutputYet(slug, path);

  try {
    return { path, ...adapter.extractResult(path, opts) };
  } catch (e) {
    // 文件在 existsSync 后才消失时仍是「没有产出」，不能把竞态报成配置或解析故障。
    if (e.code === "ENOENT") throw noOutputYet(slug, path);
    throw Object.assign(new Error(`cannot read transcript ${path}: ${e.message}`), {
      code: "transcript_unreadable",
    });
  }
}

// 回收一个受管会话的容器。只按登记表里记的句柄操作，绝不按模式匹配去扫——
// `git branch -d` 跑在用户的仓库里，扫错一个就是不可逆的。
// 分支只用安全的 -d（未合并会被 git 自己拒掉），永远不用 -D：
// 「这分支没价值了」必须有别的判据担保，不能让删除工具顺便当判据。
export function reclaimSession(entry, { deleteBranch = true } = {}) {
  const steps = [];

  if (entry.worktree_branch) {
    const r = tryHerdr(["worktree", "remove", "--workspace", entry.workspace_id, "--force"]);
    steps.push(r.ok ? "worktree_removed" : `worktree_remove_failed:${r.code}`);

    // worktree remove 【不删分支】（实测）。不补这一步，每次编排都在用户仓库里留一个分支。
    if (deleteBranch && entry.repo) {
      try {
        execFileSync("git", ["branch", "-d", entry.worktree_branch], {
          cwd: entry.repo,
          stdio: "pipe",
        });
        steps.push("branch_deleted");
      } catch (e) {
        const msg = String(e.stderr || e.message).trim().split("\n")[0];
        steps.push(`branch_delete_failed:${msg.slice(0, 80)}`);
      }
    }
  } else if (entry.workspace_id) {
    const r = tryHerdr(["workspace", "close", entry.workspace_id]);
    steps.push(r.ok ? "workspace_closed" : `workspace_close_failed:${r.code}`);
  }

  // 附带的基础 workspace（issue #13）：只收登记为【本次创建】的，且仍要过
  // 未被使用判据与 herdr 的 group 守卫；领养来的与没登记的，一个指头都不碰。
  if (entry.base_workspace?.created_by_run && entry.base_workspace?.workspace_id) {
    const back = closeBaseWorkspaceIfUnused({
      workspaceId: entry.base_workspace.workspace_id,
      label: entry.base_workspace.label ?? null,
      expectedCwd: entry.base_workspace.expected_cwd ?? null,
    });
    steps.push(
      back.status === "closed" || back.status === "already_gone"
        ? "base_workspace_closed"
        : `base_workspace_${back.status}:${back.detail.slice(0, 80)}`,
    );
  }

  return steps;
}

// 发一条指令并【确认它真的被提交了】。
//
// herdr 0.9.0 实测（2026-09-08，见 docs/findings-2026-09-08.md）：
//   · `agent prompt` 把文字与 Enter 作为一次有序提交，两者都写完才返回——claude 也不再需要
//     补回车（0.7.5 时代「只输入不回车」的前提被上游 #3506/#3685 修掉了）。多补的那个 Enter
//     在非 yolo 会话里会替人按下刚弹出的审批框默认项，所以不能留。
//   · agent 已是 blocked 时，`agent prompt` 不发任何输入、直接报 agent_blocked（0.8.2 起）。
//     应答对话框走 `agent send-keys`；要打字则走 `pane send-text` + `send-keys enter`，
//     这条路不经守卫——所以调用方必须先看过屏幕再答，那是编排层的责任，不是这里的。
// 三家 harness 的提交语义自此一致；提交与否仍只信 state_change_seq 的变化，不信命令返回值。
export function sendAndConfirm(
  target,
  text,
  { harness = "claude", keys = null, timeoutMs = 8000, intervalMs = 250 } = {},
) {
  getHarness(harness); // 只校验 harness 合法；提交语义已不按家分支
  const wantKeys = Array.isArray(keys) && keys.length > 0;
  if (!wantKeys && !(typeof text === "string" && text.length > 0)) {
    throw Object.assign(new Error("sendAndConfirm needs text or keys"), { code: "text_or_keys_required" });
  }

  const before = tryHerdr(["agent", "get", target]);
  const agent0 = before.ok ? before.result.agent : null;
  const seq0 = agent0?.state_change_seq ?? null;
  // pane send-text 只认 pane id；target 可能是 agent 名，优先用 herdr 解析出来的。
  const paneId = agent0?.pane_id ?? target;

  let delivery;
  if (wantKeys) {
    herdr(["agent", "send-keys", target, ...keys]);
    delivery = "keys";
  } else if (agent0?.agent_status === "blocked") {
    delivery = typeIntoBlocked(paneId, target, text);
  } else {
    try {
      herdr(["agent", "prompt", target, text]);
      delivery = "prompt";
    } catch (e) {
      // get 与 prompt 之间它刚好卡住了：按 herdr 此刻的回答走，不按前一刻看到的状态走。
      if (e.code !== "agent_blocked") throw e;
      delivery = typeIntoBlocked(paneId, target, text);
    }
  }

  const deadline = Date.now() + timeoutMs;
  let last = seq0;
  while (Date.now() < deadline) {
    const now = tryHerdr(["agent", "get", target]);
    if (now.ok) {
      last = now.result.agent?.state_change_seq;
      if (seq0 == null || (last != null && last !== seq0)) {
        return { submitted: true, delivery, seq_before: seq0, seq_after: last };
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  // 没观察到状态变化：文字很可能还躺在输入框里。报出去，不要假装成功。
  return { submitted: false, delivery, seq_before: seq0, seq_after: last };
}

// blocked 的 agent 只能经 pane 面打字：文字 + Enter，形状与 agent prompt 对齐。
// `pane send-text` 成功时 stdout 为【空】（0.9.0 实测，联调时被 herdr() 判成 bad_output），
// 错误仍是 stderr 上的 JSON 信封——所以走 herdrText，它只认信封与退出码。
function typeIntoBlocked(paneId, target, text) {
  herdrText(["pane", "send-text", paneId, text]);
  herdr(["agent", "send-keys", target, "enter"]);
  return "send_text";
}

function openingStartEvidence(slug, baseline, agent) {
  const status = agent?.agent_status ?? null;
  const seq = agent?.state_change_seq ?? null;
  if (status === "working" || status === "blocked") return { started: true, via: `status:${status}`, status, seq };
  // pi 的 agent start 常在首轮已完成后才返回 done；dispatchBaseline 为它退一格，
  // 所以同一条「seq 超过基线」规则仍能证明已经开始，不能另开 pi 特判。
  if (baseline != null && seq != null && seq > baseline) return { started: true, via: "state_change_seq", status, seq };

  try {
    const turns = readWorkerResult(slug).assistant_turns ?? 0;
    if (turns > 0) return { started: true, via: "assistant_turn", status, seq, turns };
  } catch {
    // transcript 尚未生成时没有证据，继续等状态或 seq；这不是读结果失败。
  }
  return { started: false, status, seq };
}

function probeOpeningStart({ slug, paneId, baseline }) {
  const now = tryHerdr(["agent", "get", paneId]);
  if (!now.ok) return { started: false, herdr_error: `${now.code}: ${now.message}` };
  return openingStartEvidence(slug, baseline, now.result.agent);
}

function waitForOpeningStart({ slug, paneId, baseline, initialAgent = null }) {
  let last = initialAgent ? openingStartEvidence(slug, baseline, initialAgent) : null;
  if (last?.started) return last;

  const deadline = Date.now() + OPENING_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    last = probeOpeningStart({ slug, paneId, baseline });
    if (last.started) return last;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, OPENING_START_INTERVAL_MS);
  }
  return last ?? { started: false };
}

function noteOpeningResend(slug, at, outcome) {
  registry.update((reg) => {
    const row = Object.values(reg.sessions).find((s) => s.slug === slug);
    if (!row) return;
    row.opening_resent_at = at;
    if (outcome instanceof Error) row.opening_resent_error = `${outcome.code || "?"}: ${outcome.message}`;
    else row.opening_resent_submitted = !!outcome?.submitted;
  });
}

function failOpeningStart(slug, message) {
  registry.update((reg) => {
    const row = Object.values(reg.sessions).find((s) => s.slug === slug);
    if (!row) return;
    row.status = "failed";
    row.failure = `opening_prompt_unconfirmed: ${message}`;
    row.opening_failed_at = new Date().toISOString();
  });
}

// agent start 成功只说明进程起来了；首轮的文字仍可能被 CLI flag 吞掉。两条
// spawn 路径都在登记完基线后调这里，避免 run_plan 把 30 分钟的空等误报为完成。
function confirmOpeningStarted({ slug, paneId, harness, openingPrompt, baseline, initialAgent }) {
  let evidence = waitForOpeningStart({ slug, paneId, baseline, initialAgent });
  if (evidence.started) return evidence;

  const resentAt = new Date().toISOString();
  let resent;
  try {
    resent = sendAndConfirm(paneId, openingPrompt, { harness });
  } catch (e) {
    noteOpeningResend(slug, resentAt, e);
    registry.auditLog(`opening prompt resend failed slug=${slug} pane=${paneId} err=${e.code || "?"}: ${e.message}`);
    const message = `worker '${slug}' showed no opening activity and resend failed: ${e.message}`;
    failOpeningStart(slug, message);
    throw Object.assign(new Error(message), { code: "opening_prompt_unconfirmed" });
  }

  noteOpeningResend(slug, resentAt, resent);
  registry.auditLog(
    `opening prompt resent slug=${slug} pane=${paneId} submitted=${resent.submitted} ` +
      `seq=${resent.seq_before ?? "?"}->${resent.seq_after ?? "?"}`,
  );

  evidence = probeOpeningStart({ slug, paneId, baseline });
  // sendAndConfirm 已经以状态变化验证补发被提交；它本身就是 prompt 确实离开输入框的证据。
  if (evidence.started || resent.submitted) return evidence.started ? evidence : { started: true, via: "resent_submitted" };

  const last = evidence.herdr_error || `status=${evidence.status ?? "unknown"} seq=${evidence.seq ?? "unknown"}`;
  const message = `worker '${slug}' never started its opening prompt after one resend (${last}); inspect its screen`;
  failOpeningStart(slug, message);
  registry.auditLog(`opening prompt unconfirmed slug=${slug} pane=${paneId} ${last}`);
  throw Object.assign(new Error(message), { code: "opening_prompt_unconfirmed" });
}
