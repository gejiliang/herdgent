#!/usr/bin/env node
// Herdgent 的编排工具通道：作为 orchestrator 会话的 stdio 子进程运行，随会话生死。
//
// 用法（写进 orchestrator 的 --mcp-config）：
//   node bin/mcp-server.mjs --root <orchestration-id> --state-dir <dir>
//
// state-dir 必须显式传：HERDR_PLUGIN_STATE_DIR 只注入插件命令，
// 【不会】传进插件启动的会话，而这个进程是被那个会话拉起来的（findings 第五节）。
import { appendFileSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createServer } from "../lib/mcp.mjs";
import { watchPaneStatus } from "../lib/events.mjs";
import { tryHerdr, herdrText } from "../lib/herdr.mjs";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const stateDirArg = flag("state-dir");
if (stateDirArg) process.env.HERDGENT_STATE_DIR = stateDirArg;

const registry = await import("../lib/registry.mjs");
const { workflowsRoot } = await import("../lib/paths.mjs");
const { startManagedSession, findWorker, reclaimSession, sendAndConfirm, readWorkerResult } =
  await import("../lib/worker.mjs");
const { SUPPORTED, getHarness } = await import("../lib/harness/index.mjs");
const { allProfiles, applyProfile } = await import("../lib/profiles.mjs");
const { allPresets, getPreset, render, missingInputs } = await import("../lib/presets.mjs");

// ---- 我是谁、这次编排叫什么 ----
//
// MCP server 有三条启动路径，身份和 root 各不相同：
//   1. orchestrate action 起的      → --root 显式给定
//   2. 全局注册后由 herdr 里的会话拉起 → 查 registry 认自己；不是 worker 就是编排者
//   3. 裸终端里 CLI 直连的会话拉起    → 必然是编排者（worker 都在 herdr 里）
//
// 【为什么要认出自己是不是 worker】：全局注册之后 worker 也会加载这些工具，
// 不拦的话它能继续 spawn，一层套一层没有底。认出来就不给它 spawn_worker，
// 但其它 MCP（nowledge-mem 之类）不受影响——比整个屏蔽掉全局 MCP 温和。
function resolveIdentity() {
  const paneId = process.env.HERDR_PANE_ID || null;

  const explicit = flag("root");
  if (explicit) return { root: explicit, role: "orchestrator", paneId };

  if (paneId) {
    // 登记【先于】起 agent，所以 worker 的 MCP server 启动时这条记录一定在。
    const me = registry.list().find((r) => r.pane_id === paneId);
    if (me?.role === "worker") {
      return { root: me.root, role: "worker", paneId, workerSlug: me.slug, workerTitle: me.title };
    }
    if (me?.root) return { root: me.root, role: "orchestrator", paneId };

    // 在 herdr 里但不是 herdgent 起的会话——用户自己开的，它就是编排者。
    // root 取 harness session id：那是唯一不随重启变化的主键。
    const r = tryHerdr(["agent", "get", paneId]);
    const sid = r.ok ? r.result.agent?.agent_session?.value : null;
    return { root: sid ? `orc:${sid}` : `orc:pane:${paneId}`, role: "orchestrator", paneId };
  }

  // 不在 herdr 里。一次性 root：会话没了就结束，下次是新的一轮，
  // 上一轮遗留的 worker 由孤儿扫描列出来问人。
  return {
    root: `orc:cli:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    role: "orchestrator",
    paneId: null,
  };
}

const IDENTITY = resolveIdentity();
const ROOT = IDENTITY.root;
const REPO = flag("repo", process.cwd());
// 并发闸有默认值但可配。plugin action invoke 【没有传参机制】，所以「每次启动前选」
// 不能靠 action 参数——改成运行时可调：启动值来自插件配置，orchestrator 可以用
// set_worker_limit 改（用户一句「这次最多开 3 个」即可）。值存在 registry 里，
// 每次 spawn 现读，所以改完立刻生效。
const DEFAULT_MAX_WORKERS = 6;
const START_MAX_WORKERS = Number(flag("max-workers", DEFAULT_MAX_WORKERS)) || DEFAULT_MAX_WORKERS;

function workerLimit() {
  return registry.getOrchestration(ROOT)?.max_workers ?? START_MAX_WORKERS;
}

// 日志【绝不能】走 stdout——那是 JSON-RPC 的信道，混进一行非协议内容就毁掉整个会话。
function log(line) {
  try {
    appendFileSync(join(registry.stateDir(), "mcp.log"), `${new Date().toISOString()} [${ROOT}] ${line}\n`);
  } catch {
    // 日志失败不值得中断服务
  }
}

// 跑一个外部命令拿文本，失败一律返回 null。给 list_models 用——
// 它问的是 pi 而不是 herdr，不该借用 herdr 的错误分类。
function runSafe(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout || "";
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

// 二次防线：身份是启动时定的，但 registry 随时在变。派活前再确认一次，
// 免得某种没想到的时序让 worker 拿到了 spawn 权限。
function assertCanSpawn() {
  if (IDENTITY.role === "worker") {
    throw Object.assign(
      new Error(
        `this session is worker '${IDENTITY.workerTitle ?? IDENTITY.workerSlug}' in orchestration ` +
          `${ROOT} — workers do not spawn workers. Report back to your orchestrator instead.`,
      ),
      { code: "workers_cannot_spawn" },
    );
  }
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
      "Start a coding agent in its own herdr workspace and hand it a task. Returns immediately with a worker handle — the agent keeps running. Prefer naming a `profile` (see list_profiles) over assembling harness/model/flags yourself. Give `branch` to isolate the work in a git worktree (do this for anything that writes code); omit it for read-only work like review or exploration. Name the worker for the WORK it does (e.g. 'auth-refactor'), never for the vendor ('claude', 'worker').",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task label shown in the herdr UI, e.g. auth-refactor" },
        profile: {
          type: "string",
          description:
            "Preset worker configuration (see list_profiles), e.g. 'claude-impl' or 'review-gemini'. Fills in harness, model and flags; anything you pass explicitly still wins.",
        },
        task: { type: "string", description: "The full instruction handed to the agent as its opening prompt" },
        harness: {
          type: "string",
          description:
            "Which agent CLI to run: 'claude' or 'codex'. Use a DIFFERENT vendor for review than the one that implemented — that independence is the whole point of cross-vendor review.",
        },
        purpose: {
          type: "string",
          description: "What kind of work this is: implement, review, explore, or search. Recorded and displayed; herdgent does not interpret it.",
        },
        branch: { type: "string", description: "Git branch name; when given, the worker runs in its own git worktree" },
        cwd: { type: "string", description: "Repository path; defaults to the orchestration's repo" },
        yolo: { type: "boolean", description: "Skip the agent's permission prompts entirely. No effect on pi, which has no approval gate." },
        model: {
          type: "string",
          description:
            "Which model to run. Only 'pi' supports this — it fronts every configured provider (Anthropic, OpenAI, Google, Moonshot, Qwen, GLM, DeepSeek), so this is how you get a genuinely different vendor's opinion. Call list_models to see what is available.",
        },
        read_only: {
          type: "boolean",
          description:
            "Restrict the worker to read-only tools. Prefer this over yolo for review and exploration — it is enforced by the tool allowlist, not by asking nicely. pi only.",
        },
      },
      required: ["title", "task"],
    },
    handler: async (args) => {
      assertCanSpawn();
      const spec = applyProfile(args);
      const harness = spec.harness || "claude";
      if (!SUPPORTED.includes(harness)) {
        throw Object.assign(
          new Error(`unsupported harness '${harness}' (supported: ${SUPPORTED.join(", ")})`),
          { code: "unsupported_harness" },
        );
      }

      if (spec.model && !getHarness(harness).supportsModel) {
        throw Object.assign(
          new Error(
            `harness '${harness}' cannot take a model (it only runs its own vendor's); ` +
              `use harness 'pi' when you need a specific model`,
          ),
          { code: "model_not_supported" },
        );
      }

      // 闸在 spawn 前查，不在 registry 里做——登记发生在 startManagedSession 内部，
      // 那时容器已经建好了，再拒绝就得回滚。
      const limit = workerLimit();
      const before = registry.countLive(ROOT);
      if (before.inRoot >= limit) {
        throw Object.assign(
          new Error(
            `this orchestration already has ${before.inRoot} live workers (limit ${limit}); ` +
              `finish or cancel some, or raise the limit with set_worker_limit`,
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
        yolo: !!spec.yolo,
        model: spec.model || null,
        readOnly: !!spec.read_only,
      });

      const after = registry.countLive(ROOT);
      const result = {
        ...publicView(entry),
        profile: spec.profile_applied,
        live_in_this_orchestration: after.inRoot,
        limit,
        live_across_all_orchestrations: after.global,
      };
      // 全局数不做硬拦截（「本编排只起了 2 个却被拒」会让人莫名其妙），
      // 但机器上一共开着多少必须一路报到 orchestrator 面前。
      const warnings = [];
      if (after.global > limit) {
        warnings.push(`${after.global} agents are live across all orchestrations on this machine`);
      }
      if (spec.profile_wants_branch && !args.branch) {
        warnings.push(
          `profile '${spec.profile_applied}' is an implementer but no branch was given — ` +
            `it will write directly in the orchestration repo instead of an isolated worktree`,
        );
      }
      if (warnings.length) result.warning = warnings.join("; ");
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
        limit: workerLimit(),
        live_across_all_orchestrations: counts.global,
      };
    },
  },
  {
    name: "orchestration_guide",
    description:
      "Read this BEFORE your first spawn_worker in a session. Without arguments it returns the default playbook (what you delegate, how reviews go across vendors, how to handle a blocked worker, how to clean up) plus the names of any custom workflows the user has written. Pass `workflow` to read one of those instead. Skill files live in different places for every harness, so this tool is how the playbook reaches all of them.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          description: "Name of a user-defined workflow (see available_workflows in the default response)",
        },
      },
      required: [],
    },
    handler: async (args) => {
      // 用户自定义工作流放 ~/.herdgent/config/workflows/*.md。它们是 prompt，
      // 不是代码——「谁评审谁、什么算验收」这类语义只能活在这里。
      const listWorkflows = () => {
        try {
          return readdirSync(workflowsRoot())
            .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
            .map((f) => f.replace(/\.md$/, ""));
        } catch {
          return []; // 目录不存在不是错误
        }
      };

      if (args.workflow) {
        const name = String(args.workflow).replace(/[^a-zA-Z0-9._-]/g, "");
        const path = join(workflowsRoot(), `${name}.md`);
        try {
          return { workflow: name, guide: readFileSync(path, "utf8") };
        } catch {
          throw Object.assign(
            new Error(`no workflow '${name}' (available: ${listWorkflows().join(", ") || "none"})`),
            { code: "unknown_workflow" },
          );
        }
      }

      const builtin = join(import.meta.dirname, "..", "skills", "orchestrate", "SKILL.md");
      try {
        return { guide: readFileSync(builtin, "utf8"), available_workflows: listWorkflows() };
      } catch (e) {
        throw Object.assign(new Error(`cannot read the guide at ${builtin}: ${e.message}`), {
          code: "guide_unreadable",
        });
      }
    },
  },
  {
    name: "list_presets",
    description:
      "List orchestration presets — a preset is a whole multi-worker sequence written down as data: who implements, who reviews, whose output feeds whom. Prefer running a preset over assembling the sequence yourself; the rules that matter (reviewer is a different vendor, implementers get their own worktree) are baked into the preset, not left to you to remember.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({
      presets: Object.entries(allPresets()).map(([name, p]) => ({
        name,
        description: p.description,
        inputs: p.inputs ?? {},
        steps: (p.steps ?? []).map((st) => ({ id: st.id, profile: st.profile, attach: st.attach })),
        parallel: !!p.parallel,
        source: p.source,
      })),
    }),
  },
  {
    name: "run_preset",
    description:
      "Run an orchestration preset end to end: it spawns each step's worker, waits for it, hands the declared artifact (a diff, a previous worker's answer) to the next step, and returns every step's result. Blocks until done — that is expected, do not poll it. If any worker comes back 'blocked' the run stops there and tells you which step, so a human can step in.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", description: "Preset name from list_presets" },
        inputs: {
          type: "object",
          description: "Values for the preset's declared inputs (see list_presets)",
        },
        base_ref: { type: "string", description: "Git ref that diffs are taken against (default: main)" },
      },
      required: ["preset", "inputs"],
    },
    handler: (args) => runPreset(args),
  },
  {
    name: "list_profiles",
    description:
      "List the worker profiles available to spawn_worker. A profile bundles harness + model + flags under one name, so you pick a role instead of assembling five parameters. Model availability is cross-checked against what pi can actually run right now.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const profiles = allProfiles();
      const listed = runSafe(["pi", "--list-models"]);
      const available = new Set(
        (listed ?? "")
          .split("\n")
          .slice(1)
          .map((l) => l.trim().split(/\s+/)[1])
          .filter(Boolean),
      );
      return {
        profiles: Object.entries(profiles).map(([name, p]) => ({
          name,
          ...p,
          // 模型名会随网关配置漂移。标出来，别让编排者拿着跑不起来的 profile 去派活。
          model_available: p.model ? (listed == null ? "unknown" : available.has(p.model)) : null,
        })),
      };
    },
  },
  {
    name: "list_models",
    description:
      "List the models available to pi workers. Use it before dispatching a review to pick a vendor genuinely different from the implementer's.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const out = runSafe(["pi", "--list-models"]);
      if (out == null) return { available: false, note: "pi is not on PATH" };
      const models = out
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c.length >= 2 && c[0] && c[1])
        .map(([provider, model]) => `${provider}/${model}`);
      return { models, count: models.length };
    },
  },
  {
    name: "set_worker_limit",
    description:
      "Change how many workers this orchestration may run at once. Ask the human before raising it — every worker is a real agent burning their quota. Lowering it never kills running workers, it only blocks new ones.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum concurrent live workers for this orchestration" },
      },
      required: ["limit"],
    },
    handler: async (args) => {
      const n = Math.floor(Number(args.limit));
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        throw Object.assign(new Error(`limit must be between 1 and 50, got ${args.limit}`), {
          code: "bad_limit",
        });
      }
      const previous = workerLimit();
      registry.putOrchestration(ROOT, { max_workers: n });
      const counts = registry.countLive(ROOT);
      return {
        limit: n,
        previous,
        live: counts.inRoot,
        ...(counts.inRoot > n
          ? { note: `${counts.inRoot} workers are already live; none were stopped, but no new ones can start until it drops below ${n}` }
          : {}),
      };
    },
  },
  {
    name: "ping",
    description: "Health check for the herdgent orchestration channel. Returns a fixed marker, this orchestration's id, and which harnesses are available.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({
      ok: true,
      marker: "HERDGENT_MCP_ALIVE",
      root: ROOT,
      role: IDENTITY.role,
      pid: process.pid,
      harnesses: SUPPORTED,
      ...(IDENTITY.role === "worker"
        ? { note: `this session is worker '${IDENTITY.workerTitle ?? IDENTITY.workerSlug}'; it cannot spawn more workers` }
        : {}),
    }),
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

      const t = readWorkerResult(w.slug);
      return {
        worker_id: w.slug,
        title: w.title,
        purpose: w.purpose,
        harness: w.harness,
        status: w.status,
        ...t,
      };
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
      const r = sendAndConfirm(w.pane_id, args.text, { harness: w.harness || "claude" });
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

// 预设引擎的两个「取产物」动作。刻意只有这两个，且都是机械操作：
//   diff_of:<step-id>   —— 那一步的 worktree 分支相对 base 的 diff
//   diff_of:<git-ref>   —— 直接给 git diff 的参数
//   result_of:<step-id> —— 那一步 worker 的最后一条回复
// 引擎不知道 diff 是拿来干嘛的，它只负责落成文件、把路径交给下一步。
function resolveArtifact(spec, ctx) {
  const [kind, rest] = String(spec).split(":", 2);
  const dir = join(registry.stateDir(), "artifacts", ctx.runId);
  mkdirSync(dir, { recursive: true });

  if (kind === "diff_of") {
    const upstream = ctx.steps[rest];
    const ref = upstream?.branch ? `${ctx.baseRef}..${upstream.branch}` : rest;
    const out = runSafe(["git", "-C", ctx.repo, "diff", ref]);
    if (out == null) {
      throw Object.assign(new Error(`git diff ${ref} failed in ${ctx.repo}`), { code: "diff_failed" });
    }
    const path = join(dir, `${rest.replace(/[^\w.-]/g, "_")}.diff`);
    writeFileSync(path, out);
    return { path, bytes: out.length };
  }

  if (kind === "result_of") {
    const upstream = ctx.steps[rest];
    if (!upstream) throw Object.assign(new Error(`no step '${rest}' to take a result from`), { code: "bad_artifact" });
    const r = readWorkerResult(upstream.worker_id);
    const path = join(dir, `${rest.replace(/[^\w.-]/g, "_")}.md`);
    writeFileSync(path, r.text ?? "");
    return { path, bytes: (r.text ?? "").length };
  }

  throw Object.assign(new Error(`unknown artifact '${spec}' (use diff_of:<id> or result_of:<id>)`), {
    code: "bad_artifact",
  });
}

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
// 预设引擎。【刻意保持哑】：只做四件事——渲染任务文本、派活、等完成、取产物。
// 它不知道 impl / review 是什么意思，换个预设就干完全不同的事。
async function runPreset({ preset: name, inputs = {}, base_ref: baseRef = "main" }) {
  assertCanSpawn();
  const preset = getPreset(name);

  // 先检查参数再动手：跑到一半才发现缺输入，前面烧掉的额度回不来。
  const missing = missingInputs(preset, inputs);
  if (missing.length) {
    throw Object.assign(
      new Error(`preset '${name}' needs: ${missing.join(", ")} (see list_presets for what each means)`),
      { code: "missing_inputs" },
    );
  }

  const runId = `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const ctx = { runId, repo: REPO, baseRef, steps: {} };
  const results = [];
  log(`preset ${name} start run=${runId} steps=${preset.steps.length}`);

  for (const step of preset.steps) {
    const vars = { ...inputs };

    // 产物：上一步的 diff / 回复，落成文件，把路径给下一步。
    let attached = null;
    if (step.attach) {
      const spec = render(step.attach, vars);
      attached = resolveArtifact(spec, ctx);
      vars.attached = attached.path;
    }

    const title = render(step.title || step.id, vars);
    const branch = step.branch ? render(step.branch, vars) : null;
    const task = render(step.task, vars);

    let entry;
    try {
      const spec = applyProfile({ profile: step.profile });
      entry = startManagedSession({
        cwd: REPO,
        task,
        harness: spec.harness || "claude",
        role: "worker",
        root: ROOT,
        parent: ROOT,
        title,
        purpose: step.id,
        branch,
        yolo: !!spec.yolo,
        model: spec.model || null,
        readOnly: !!spec.read_only,
      });
    } catch (e) {
      results.push({ step: step.id, ok: false, error: e.code || "spawn_failed", message: e.message });
      log(`preset ${name} step ${step.id} spawn failed: ${e.message}`);
      return { run: runId, preset: name, completed: false, stopped_at: step.id, results };
    }

    ctx.steps[step.id] = { worker_id: entry.slug, branch, title };
    const waited = await waitForWorkers([entry.slug]);
    const settled = waited.settled?.[0];

    // blocked = 那个 worker 停在审批或提问界面上，不处理就永远不动。
    // 引擎不替人做决定：停下来，报清楚卡在哪一步。
    if (settled?.status === "blocked") {
      results.push({ step: step.id, ok: false, worker_id: entry.slug, status: "blocked", title });
      log(`preset ${name} stopped: step ${step.id} blocked`);
      return {
        run: runId,
        preset: name,
        completed: false,
        stopped_at: step.id,
        reason: "a worker needs a human — read_worker mode=screen to see what it is asking",
        results,
      };
    }

    let text = "";
    try {
      text = readWorkerResult(entry.slug).text ?? "";
    } catch (e) {
      text = `(结果暂时读不到：${e.code})`;
    }
    results.push({
      step: step.id,
      ok: true,
      worker_id: entry.slug,
      title,
      profile: step.profile,
      branch,
      attached: attached?.path,
      result: text,
    });
    log(`preset ${name} step ${step.id} done worker=${entry.slug}`);
  }

  return { run: runId, preset: name, completed: true, results };
}

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
    max_workers: registry.getOrchestration(ROOT)?.max_workers ?? START_MAX_WORKERS,
    repo: REPO,
    started_at: new Date().toISOString(),
  });
} catch (e) {
  log(`orchestration record failed: ${e.code || "?"}: ${e.message}`);
}

// worker 拿不到派活类工具：认得出自己是 worker，就把这些摘掉，
// 免得它在工具列表里看到 spawn_worker 而动念递归。
const WORKER_HIDDEN = new Set([
  "spawn_worker",
  "cancel_worker",
  "set_worker_limit",
  "send_to_worker",
  "wait_for_worker",
]);
const EXPOSED = IDENTITY.role === "worker" ? TOOLS.filter((t) => !WORKER_HIDDEN.has(t.name)) : TOOLS;

log(`identity: role=${IDENTITY.role} root=${ROOT} pane=${IDENTITY.paneId ?? "-"} tools=${EXPOSED.length}`);

createServer({ name: "herdgent", version: "0.1.0", tools: EXPOSED, onLog: log });
