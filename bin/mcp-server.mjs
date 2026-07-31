#!/usr/bin/env node
// Herdgent 的编排工具通道：作为 orchestrator 会话的 stdio 子进程运行，随会话生死。
//
// 用法（写进 orchestrator 的 --mcp-config）：
//   node bin/mcp-server.mjs --root <orchestration-id> --state-dir <dir>
//
// state-dir 必须显式传：HERDR_PLUGIN_STATE_DIR 只注入插件命令，
// 【不会】传进插件启动的会话，而这个进程是被那个会话拉起来的（findings 第五节）。
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../lib/mcp.mjs";
import { watchPaneStatus } from "../lib/events.mjs";
import { tryHerdr, herdrText } from "../lib/herdr.mjs";
import { lastAssistantText } from "../lib/transcript.mjs";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const stateDirArg = flag("state-dir");
if (stateDirArg) process.env.HERDGENT_STATE_DIR = stateDirArg;

const registry = await import("../lib/registry.mjs");
const { startManagedSession, findWorker, reclaimSession, sendAndConfirm } = await import(
  "../lib/worker.mjs"
);

const ROOT = flag("root", "adhoc");
const REPO = flag("repo", process.cwd());
// 并发闸有默认值但可配：每次编排的规模不一样，写死会挡住合理的大扇出。
// 值由 orchestrate action 在启动时按用户选择传进来，落在 registry 里。
const DEFAULT_MAX_WORKERS = 6;
const MAX_WORKERS = Number(flag("max-workers", DEFAULT_MAX_WORKERS)) || DEFAULT_MAX_WORKERS;

// 日志【绝不能】走 stdout——那是 JSON-RPC 的信道，混进一行非协议内容就毁掉整个会话。
function log(line) {
  try {
    appendFileSync(join(registry.stateDir(), "mcp.log"), `${new Date().toISOString()} [${ROOT}] ${line}\n`);
  } catch {
    // 日志失败不值得中断服务
  }
}

// 对外的 worker 句柄用 slug，不用 registry 的 key：
// key 会被 SessionStart 钩子从 pending:<slug> 改写成 claude:<uuid>，而 slug 自始至终不变。
function publicView(s) {
  return {
    worker_id: s.slug,
    title: s.title,
    purpose: s.purpose,
    harness: s.harness,
    status: s.status,
    workspace_id: s.workspace_id,
    pane_id: s.pane_id,
    branch: s.worktree_branch,
    cwd: s.cwd,
    yolo: !!s.yolo,
    harness_session_id: s.harness_session_id,
  };
}

function mustFindWorker(workerId) {
  const s = findWorker(workerId);
  if (!s || s.root !== ROOT) {
    // 归属边界：只认本次编排派出去的 worker。别的编排的、GG 手起的，一律查无此人。
    throw Object.assign(new Error(`no worker '${workerId}' in this orchestration`), {
      code: "worker_not_found",
    });
  }
  return s;
}

const TOOLS = [
  {
    name: "spawn_worker",
    description:
      "Start a coding agent in its own herdr workspace and hand it a task. Returns immediately with a worker handle — the agent keeps running. Give `branch` to isolate the work in a git worktree (do this for anything that writes code); omit it for read-only work like review or exploration. Name the worker for the WORK it does (e.g. 'auth-refactor'), never for the vendor ('claude', 'worker').",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task label shown in the herdr UI, e.g. auth-refactor" },
        task: { type: "string", description: "The full instruction handed to the agent as its opening prompt" },
        harness: { type: "string", description: "Which agent CLI to run (v0.1 supports 'claude')" },
        purpose: {
          type: "string",
          description: "What kind of work this is: implement, review, explore, or search. Recorded and displayed; herdgent does not interpret it.",
        },
        branch: { type: "string", description: "Git branch name; when given, the worker runs in its own git worktree" },
        cwd: { type: "string", description: "Repository path; defaults to the orchestration's repo" },
        yolo: { type: "boolean", description: "Skip the agent's permission prompts (--dangerously-skip-permissions)" },
      },
      required: ["title", "task"],
    },
    handler: async (args) => {
      const harness = args.harness || "claude";
      if (harness !== "claude") {
        throw Object.assign(new Error(`v0.1 only supports harness 'claude', got '${harness}'`), {
          code: "unsupported_harness",
        });
      }

      // 闸在 spawn 前查，不在 registry 里做——登记发生在 startManagedSession 内部，
      // 那时容器已经建好了，再拒绝就得回滚。
      const before = registry.countLive(ROOT);
      if (before.inRoot >= MAX_WORKERS) {
        throw Object.assign(
          new Error(
            `this orchestration already has ${before.inRoot} live workers (limit ${MAX_WORKERS}); ` +
              `finish or cancel some before spawning more`,
          ),
          { code: "worker_limit_reached" },
        );
      }

      const entry = startManagedSession({
        cwd: args.cwd || REPO,
        task: args.task,
        harness,
        role: "worker",
        root: ROOT,
        parent: ROOT,
        title: args.title,
        purpose: args.purpose || null,
        branch: args.branch || null,
        yolo: !!args.yolo,
      });

      const after = registry.countLive(ROOT);
      const result = {
        ...publicView(entry),
        live_in_this_orchestration: after.inRoot,
        limit: MAX_WORKERS,
        live_across_all_orchestrations: after.global,
      };
      // 全局数不做硬拦截（「本编排只起了 2 个却被拒」会让人莫名其妙），
      // 但机器上一共开着多少必须一路报到 orchestrator 面前。
      if (after.global > MAX_WORKERS) {
        result.warning = `${after.global} agents are live across all orchestrations on this machine`;
      }
      return result;
    },
  },
  {
    name: "list_workers",
    description:
      "List the workers this orchestration has started, with their current status. Use it to recover your view after losing track, or to check what is still running before spawning more.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const rows = registry.list().filter((s) => s.role === "worker" && s.root === ROOT);
      const counts = registry.countLive(ROOT);
      return {
        workers: rows.map(publicView),
        live: counts.inRoot,
        limit: MAX_WORKERS,
        live_across_all_orchestrations: counts.global,
      };
    },
  },
  {
    name: "ping",
    description: "Health check for the herdgent orchestration channel. Returns a fixed marker plus this orchestration's id.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({ ok: true, marker: "HERDGENT_MCP_ALIVE", root: ROOT, pid: process.pid }),
  },
  {
    name: "herdr_status",
    description: "Check that herdr itself is reachable from this orchestration channel. Returns the current workspace count.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const r = tryHerdr(["workspace", "list"]);
      if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
      return { ok: true, workspaces: (r.result.workspaces || []).length };
    },
  },
  {
    name: "wait_for_worker",
    description:
      "Block until at least one worker finishes its turn (done or idle) or needs a human (blocked), then return which ones settled. Blocks for as long as it takes — do NOT poll this in a loop with short waits. If a worker comes back 'blocked' it is waiting on an approval or a question and will not progress until someone answers it.",
    inputSchema: {
      type: "object",
      properties: {
        worker_ids: {
          type: "array",
          items: { type: "string" },
          description: "Which workers to wait on. Omit to wait on every live worker in this orchestration.",
        },
      },
      required: [],
    },
    handler: (args) => waitForWorkers(args.worker_ids),
  },
  {
    name: "read_worker",
    description:
      "Read what a worker produced. mode='result' (default) returns its last reply — this is the deliverable. mode='screen' returns the raw terminal view, for diagnosing a worker that went quiet or looks stuck.",
    inputSchema: {
      type: "object",
      properties: {
        worker_id: { type: "string", description: "Worker handle from spawn_worker" },
        mode: { type: "string", description: "'result' (default) or 'screen'" },
        lines: { type: "number", description: "screen mode only: how many terminal lines (default 60)" },
      },
      required: ["worker_id"],
    },
    handler: async (args) => {
      const w = mustFindWorker(args.worker_id);
      const mode = args.mode || "result";

      if (mode === "screen") {
        // agent read 吐的是终端内容本身，不是 JSON——必须走 herdrText，
        // 否则 JSON 解析会把正常输出当成协议损坏。
        const screen = herdrText([
          "agent", "read", w.pane_id,
          "--source", "visible",
          "--lines", String(Number(args.lines) || 60),
        ]);
        return { worker_id: w.slug, mode, screen };
      }

      if (!w.transcript_path) {
        // 钩子还没回填。这不是错误——刚起的 worker 就是这样，重试即可。
        throw Object.assign(
          new Error(`worker '${w.slug}' has no transcript yet; it may still be starting`),
          { code: "transcript_not_ready" },
        );
      }
      try {
        const t = lastAssistantText(w.transcript_path);
        return { worker_id: w.slug, title: w.title, purpose: w.purpose, status: w.status, ...t };
      } catch (e) {
        throw Object.assign(new Error(`cannot read transcript: ${e.message}`), {
          code: "transcript_unreadable",
        });
      }
    },
  },
  {
    name: "send_to_worker",
    description:
      "Send a follow-up instruction to a worker that is already running. Use this to answer a worker that came back 'blocked', or to correct course. Returns submitted=false if the text could not be confirmed as submitted — treat that as 'not delivered' and retry rather than assuming it landed.",
    inputSchema: {
      type: "object",
      properties: {
        worker_id: { type: "string", description: "Worker handle from spawn_worker" },
        text: { type: "string", description: "The instruction to send" },
      },
      required: ["worker_id", "text"],
    },
    handler: async (args) => {
      const w = mustFindWorker(args.worker_id);
      const r = sendAndConfirm(w.pane_id, args.text);
      if (r.submitted) {
        // 基线取【发送前】的 seq，不能取 seq_after：sendAndConfirm 一观察到变化就返回，
        // 而一个极短的任务在那之前就跑完了——拿终态当基线等于要求「比终态更新」，
        // wait 会永久等下去（实测踩到，卡了 10 分钟）。用 seq_before 则任何后续变化都严格大于它。
        registry.update((reg) => {
          const row = Object.values(reg.sessions).find((s) => s.slug === w.slug);
          if (row && r.seq_before != null) row.dispatch_seq = r.seq_before;
        });
      } else {
        log(`send_to_worker unconfirmed for ${w.slug}: seq ${r.seq_before} -> ${r.seq_after}`);
      }
      return { worker_id: w.slug, ...r };
    },
  },
  {
    name: "cancel_worker",
    description:
      "Stop a worker. mode='interrupt' (default) aborts only its current turn — the worker stays alive and you can send it new work. mode='terminate' shuts the worker down and reclaims its workspace, git worktree and branch; that is irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        worker_id: { type: "string", description: "Worker handle from spawn_worker" },
        mode: { type: "string", description: "'interrupt' (default) or 'terminate'" },
      },
      required: ["worker_id"],
    },
    handler: async (args) => {
      const w = mustFindWorker(args.worker_id);
      const mode = args.mode || "interrupt";

      if (mode === "interrupt") {
        // 实测 ctrl+c 只中断当前轮，进程还在、输入框可继续派活。
        const r = tryHerdr(["agent", "send-keys", w.pane_id, "ctrl+c"]);
        if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
        const after = tryHerdr(["agent", "get", w.pane_id]);
        return {
          worker_id: w.slug,
          method: "interrupt",
          alive: true,
          status: after.ok ? after.result.agent?.agent_status : "unknown",
          note: "worker is still alive and can take new work",
        };
      }

      if (mode !== "terminate") {
        throw Object.assign(new Error(`unknown mode '${mode}' (use interrupt or terminate)`), {
          code: "bad_mode",
        });
      }

      const steps = reclaimSession(w);
      registry.update((reg) => {
        const row = Object.values(reg.sessions).find((s) => s.slug === w.slug);
        if (row) {
          row.status = "terminated";
          row.terminated_at = new Date().toISOString();
          row.reclaim_steps = steps;
        }
      });
      return { worker_id: w.slug, method: "terminate", alive: false, steps };
    },
  },
];

const SETTLED = new Set(["done", "idle", "blocked"]);
// wait 的兜底上限。不是正常退出路径——正常靠事件。它只保证「判据写错」不会变成永久挂起。
const WAIT_CEILING_MS = 30 * 60 * 1000;

// 判断一个 worker 是不是【这一轮】结束了。
//
// 光看状态不够：worker 上一轮结束后就停在 done/idle 上，刚派完新活时状态还没转成
// working，此刻查到的 done 是【上一轮的】终态。直接返回会让 orchestrator 立刻去读
// 结果，读到的是旧回答（实测踩到：中断后重新派活，wait 立即返回、read 拿回被中断的旧文本）。
// findings 第二节第 3 条警告过这一点——herdr 没有 "since seq" 参数，去重必须自己做。
//
// 所以用 dispatch_seq：派活时记下当时的 state_change_seq，只有严格大于它的终态才算数。
// 每次都重读 registry，因为 wait 阻塞期间可能有 send_to_worker 推进了这个基线。
function settledNow(slug) {
  const w = findWorker(slug);
  if (!w) return null;
  const r = tryHerdr(["agent", "get", w.pane_id]);
  if (!r.ok) return null;
  const agent = r.result.agent;
  if (!SETTLED.has(agent?.agent_status)) return null;
  const seq = agent.state_change_seq;
  if (w.dispatch_seq != null && seq != null && seq <= w.dispatch_seq) return null;
  return { status: agent.agent_status, seq };
}

// 等一批 worker，任一进入终态就返回——这对应 polly 的 inbox 语义：
// 拿到一个就去处理它，而不是傻等全部跑完。
//
// 【一个 pane 一条连接】是实测约束（events.mjs 文件头）：pane.agent_status_changed
// 必填 pane_id，而订阅数组里有一个不存在的 pane 就整个请求被拒。合订会让
// 一个 worker 的死亡牵连所有其他 worker 的等待。
function waitForWorkers(workerIds) {
  const all = registry.list().filter((s) => s.role === "worker" && s.root === ROOT);
  const targets = (
    workerIds?.length ? workerIds.map((id) => mustFindWorker(id)) : all
  ).filter((w) => w.status === "active" && w.pane_id);

  if (targets.length === 0) {
    return Promise.resolve({ settled: [], still_running: [], note: "no live workers to wait on" });
  }

  return new Promise((resolve) => {
    const subs = [];
    const settled = [];
    const broken = [];
    let finished = false;
    let timedOut = false;

    // 兜底上限。正常情况靠事件返回，这条只防「判据写错了就永久挂起」——
    // 实测吃过一次亏：基线取错导致条件永不成立，调用一直挂着，谁也看不出为什么。
    // 到点返回 still_running，把决定权交回 orchestrator，而不是无限期占着一个调用。
    const ceiling = setTimeout(() => {
      timedOut = true;
      finish();
    }, WAIT_CEILING_MS);

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(ceiling);
      for (const s of subs) {
        try {
          s.close();
        } catch {
          // 已经断了
        }
      }
      const settledIds = new Set(settled.map((s) => s.worker_id));
      resolve({
        settled,
        still_running: targets.filter((t) => !settledIds.has(t.slug)).map((t) => t.slug),
        // 流断掉的 worker 单独列出：调用方必须能区分「等到了」和「看不见了」。
        ...(broken.length ? { unreachable: broken } : {}),
        ...(timedOut
          ? {
              timed_out_after_s: WAIT_CEILING_MS / 1000,
              note: "nothing settled within the ceiling; the workers may still be working — check read_worker mode=screen, or wait again",
            }
          : {}),
      });
    };

    const record = (w, status, via, seq) => {
      if (settled.some((s) => s.worker_id === w.slug)) return;
      settled.push({ worker_id: w.slug, title: w.title, purpose: w.purpose, status, via, seq });
      finish();
    };

    for (const w of targets) {
      const sub = watchPaneStatus(w.pane_id, {
        onReady: () => {
          // 补查一次：订阅建立完成【之前】的状态变化不会被推送，
          // 不补就会漏掉「调用时其实已经结束了」，然后一直等下去。
          const now = settledNow(w.slug);
          if (now) record(w, now.status, "poll", now.seq);
        },
        onStatus: () => {
          // 事件里没有 seq，所以收到推送后仍要回查一次才能判定是不是【这一轮】结束。
          const now = settledNow(w.slug);
          if (now) record(w, now.status, "event", now.seq);
        },
        onError: (e) => {
          broken.push({ worker_id: w.slug, reason: `${e.code}: ${e.message}` });
          if (broken.length === targets.length) finish(); // 全都联系不上了，别干等
        },
        onClose: () => {
          broken.push({ worker_id: w.slug, reason: "event_stream_closed" });
          if (broken.length === targets.length) finish();
        },
      });
      subs.push(sub);
    }
  });
}

// 登记本次编排的规模上限，让 list_workers / 事后排查都能看到当时选了多少。
try {
  registry.putOrchestration(ROOT, {
    max_workers: MAX_WORKERS,
    repo: REPO,
    started_at: new Date().toISOString(),
  });
} catch (e) {
  log(`orchestration record failed: ${e.code || "?"}: ${e.message}`);
}

createServer({ name: "herdgent", version: "0.0.1", tools: TOOLS, onLog: log });
