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
const {
  startManagedSession,
  startAgentInPane,
  createOrchestrationSpace,
  openStageTab,
  splitForParallel,
  setStageStatus,
  markStageRunning,
  reconcileLive,
  findWorker,
  sendAndConfirm,
  readWorkerResult,
} = await import("../lib/worker.mjs");
const { SUPPORTED } = await import("../lib/harness/index.mjs");
const { allProfiles, applyProfile } = await import("../lib/profiles.mjs");
const { allPresets, getPreset, render, missingInputs } = await import("../lib/presets.mjs");
const { allModes, getMode, skillPathFor } = await import("../lib/modes.mjs");

// ---- 我是谁、这次编排叫什么 ----
//
// 【编排身份绑项目，不绑会话】。编排者恒等于「坐在这个项目工作区里的那个会话」，
// 而会话是会重启、会被 compact、会被关掉的。早先 root 取 harness session id，
// 于是 GG 一重启会话 root 就变了，上一轮派出去的 worker 全部落在射程外——
// list_workers 返回空数组，同时 live_across_all_orchestrations 显示 1，
// 看得见却碰不到，那一个 worker 就成了没人能收的孤儿。
//
// 绑到 repo 之后，会话重启自然接手上一轮的 worker。同一个项目同时开两个会话
// 也会共享同一次编排——那是对的：它们在同一个项目里干活，本来就该互相看得见，
// 并发闸也该一起算。
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
  }

  // 不是 worker，就是编排者——不管在不在 herdr 里。CLI 直连和 herdr 里的会话
  // 拿到同一个 root：GG 说过他会在不关注过程时直接用 CLI，那时仍是同一个项目
  // 的同一摊活，没理由分家。
  return { root: `orc:repo:${projectKey()}`, role: "orchestrator", paneId };
}

// 项目的稳定标识。用 git 主仓库而不是 cwd：worker 跑在 worktree 里，
// 人也可能在 worktree 里开会话，那些都该算同一个项目。
// --git-common-dir 在 worktree 里返回【主仓库】的 .git，这正是要的东西。
function projectKey() {
  const cwd = flag("repo", process.cwd());
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (!r.error && r.status === 0) {
    const gitDir = (r.stdout || "").trim();
    if (gitDir) return gitDir.replace(/\/\.git\/?$/, "") || gitDir;
  }
  return cwd; // 不在 git 仓库里也能编排，退回目录本身
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

// 跑一个外部命令拿文本，失败一律返回 null。给取 git diff 用——
// 问的不是 herdr，不该借用 herdr 的错误分类。
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
    // status 是【归属】（还在不在这次编排里），agent_status 是【活儿】
    // （working / idle / done / blocked，herdr 现报的）。两件事，两格。
    agent_status: s.agent_status ?? null,
    workspace_id: s.workspace_id,
    tab_id: s.tab_id,
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
      "Start a coding agent in its own herdr workspace and hand it a task. Returns immediately with a worker handle — the agent keeps running. `profile` decides everything about HOW it runs (harness, model, prompt, permissions) and is required; you choose the role, not the parts. Give `branch` to isolate the work in a git worktree (do this for anything that writes code); omit it for read-only work like review or exploration. Name the worker for the WORK it does (e.g. 'auth-refactor'), never for the vendor ('claude', 'worker').",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task label shown in the herdr UI, e.g. auth-refactor" },
        profile: {
          type: "string",
          description:
            "Which profile to run this worker on (see list_profiles), e.g. 'impl-gpt' or 'review-opus'. This is the only way to pick harness/model/permissions — there is no per-call override. For cross-vendor review, dispatch the same task to profiles on different vendors.",
        },
        task: { type: "string", description: "The full instruction handed to the agent as its opening prompt" },
        purpose: {
          type: "string",
          description: "What kind of work this is: implement, review, explore, or search. Recorded and displayed; herdgent does not interpret it.",
        },
        branch: { type: "string", description: "Git branch name; when given, the worker runs in its own git worktree" },
        cwd: { type: "string", description: "Repository path; defaults to the orchestration's repo" },
      },
      required: ["title", "task", "profile"],
    },
    handler: async (args) => {
      assertCanSpawn();
      const spec = applyProfile(args);
      const harness = spec.harness;
      if (!SUPPORTED.includes(harness)) {
        throw Object.assign(
          new Error(`profile '${args.profile}' names unsupported harness '${harness}' (supported: ${SUPPORTED.join(", ")})`),
          { code: "unsupported_harness" },
        );
      }

      // 闸在 spawn 前查，不在 registry 里做——登记发生在 startManagedSession 内部，
      // 那时容器已经建好了，再拒绝就得回滚。
      //
      // 数之前先跟 herdr 对账：registry 的状态是缓存，跑完/死掉的 worker 不对账
      // 就永远算 live，闸会被幽灵记录一点点堵死（FIXME #1）。
      reconcileLive(ROOT);
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
        effort: spec.effort || null,
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
      // 先对账再报数：编排者调这个多半就是因为「我不确定现在有几个在跑」，
      // 这时给它一份过期的缓存等于没答。
      reconcileLive(ROOT);
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
      "Read this BEFORE your first spawn_worker. Without arguments it lists the orchestration modes (rex for development, fox for read-only research) and any custom workflows; pass `mode` to read that mode's full playbook. Skill files live in different places for every harness, so this tool is how the playbook reaches all of them.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Orchestration mode to read: 'rex' or 'fox' (see the default response)" },
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

      if (args.mode) {
        const m = getMode(args.mode);
        const path = skillPathFor(m, args.mode);
        if (!path) {
          throw Object.assign(new Error(`mode '${args.mode}' has no playbook file`), {
            code: "guide_unreadable",
          });
        }
        return { mode: args.mode, container: m.container, guide: readFileSync(path, "utf8") };
      }

      return {
        modes: Object.entries(allModes()).map(([name, m]) => ({
          name,
          container: m.container,
          description: m.description,
          source: m.source,
        })),
        available_workflows: listWorkflows(),
        next: "call orchestration_guide again with mode='rex' or mode='fox' to read that playbook",
      };
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
    name: "run_plan",
    description:
      "Run an orchestration you assembled yourself. The whole run lives in ONE container decided by `mode`: 'rex' (default, anything that writes code) gets a git worktree workspace with its own branch; 'fox' (read-only research) just adds tabs to your current workspace. Either way each step becomes a tab, and parallel workers inside a step become panes in that tab — the human sees one container per orchestration, not scattered workspaces. All workers share that worktree and branch, so when a step runs several writers, give each one a disjoint slice of the work. Steps run in ORDER; within one step, giving `task` an array spawns that many workers IN PARALLEL, and giving `profile` an array runs the SAME task on several vendors (that is how cross-vendor review is done). Decide the shape from the size of the job — a one-file fix needs one implementer and one reviewer; a refactor across modules may want several implementers on separate branches and three reviewers from different vendors. Each step names a profile (see list_profiles), which already carries the harness, model, prompt and permissions. Blocks until the whole plan finishes.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Steps in execution order",
          items: {
            type: "object",
            properties: {
              profile: {
                description: "Profile name, or an array of names to run the same task on several vendors at once",
                anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              },
              task: {
                description: "One instruction (string) or several to run in parallel (array of strings)",
                anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              },
              id: { type: "string", description: "Name this step so later steps can attach its output; defaults to its index" },
              title: { type: "string", description: "Stage name — becomes the tab label the human sees" },
              attach: {
                type: "string",
                description: "Feed a previous step's output in: 'diff_of:<step>' or 'result_of:<step>'. The file path lands in the task as {{attached}}.",
              },
            },
            required: ["profile", "task"],
          },
        },
        label: { type: "string", description: "Name of this orchestration — the human sees it as the workspace or tab label" },
        mode: {
          type: "string",
          description:
            "Which kind of orchestration this is. 'rex' (default) is development work — it gets its own git worktree and branch, use it for ANYTHING that writes code. 'fox' is read-only research — it just adds tabs to your current workspace, no branch to clean up afterwards. Read the matching playbook with orchestration_guide first.",
        },
        branch: { type: "string", description: "Branch for the worktree; omit and herdr names one automatically. Ignored when container is 'tab'." },
        base_ref: { type: "string", description: "Git ref that diffs are taken against (default: main)" },
      },
      required: ["steps"],
    },
    handler: (args) => runPlan(args),
  },
  {
    name: "run_preset",
    description:
      "Run a saved orchestration template — same engine as run_plan, but the steps are already written down. Use this when a preset matches what you need; use run_plan when the job's shape is different from any of them.",
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
      "List the worker profiles you can dispatch. A profile is the ONLY way to say what a worker runs on — it carries the harness, model, prompt and permissions as one named unit, and you cannot override any of it per call. Pick the role you need; if none fits, say so to the human rather than trying to assemble one.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({
      profiles: Object.entries(allProfiles()).map(([name, p]) => ({ name, ...p })),
    }),
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
      "Send a follow-up instruction to a worker that is already running. Use this to answer a worker that came back 'blocked', or to send work back for rework. Its stage tab automatically flips back to in-progress, so the sidebar stops claiming that step is finished. Returns submitted=false if the text could not be confirmed as submitted — treat that as 'not delivered' and retry rather than assuming it landed.",
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
      // 发送【之前】的轮次数才是这一轮的基线——发完再数就把新回复也算进去了。
      let turnsBefore = 0;
      try {
        turnsBefore = readWorkerResult(w.slug).assistant_turns ?? 0;
      } catch {
        turnsBefore = 0;
      }
      const r = sendAndConfirm(w.pane_id, args.text, { harness: w.harness || "claude" });
      if (r.submitted) {
        // 派了新活 → 这个环节又在跑了，tab 后缀从 ✓ 退回 ⋯。
        // 挂在这里而不是给编排者一个「改状态」的动词：状态该由【实际发生的事】
        // 驱动。靠编排者记得去标一定会漏——review 打回 impl 那次就是这么漏的，
        // 侧栏显示「全部完成」而实际上有人正在返工。
        markStageRunning(ROOT, w.tab_id);
        // 基线取【发送前】的 seq，不能取 seq_after：sendAndConfirm 一观察到变化就返回，
        // 而一个极短的任务在那之前就跑完了——拿终态当基线等于要求「比终态更新」，
        // wait 会永久等下去（实测踩到，卡了 10 分钟）。用 seq_before 则任何后续变化都严格大于它。
        registry.update((reg) => {
          const row = Object.values(reg.sessions).find((s) => s.slug === w.slug);
          if (!row) return;
          row.dispatch_turns = turnsBefore;
          if (r.seq_before != null) row.dispatch_seq = r.seq_before;
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
      "Stop a worker. mode='interrupt' (default) aborts its current turn; the worker stays in the orchestration and you can send it new work. mode='terminate' also drops it from the orchestration so it stops counting against the worker limit. NEITHER mode destroys anything: the pane, tab, worktree and branch all stay, because they are the human's record of what happened. Terminating one worker never touches its siblings.",
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

      // ⚠️ terminate 【绝不能】回收容器。以前这里调 reclaimSession(w)，而 worker 的
      // workspace_id 是【整个编排共用的那个 workspace】——于是「终止一个 worker」
      // 实际会 worktree remove 掉整个容器、git branch -D 掉分支，连同还在跑的
      // 兄弟 worker 和已经产出的成果一起没。踩过：一次 terminate 端掉了同一编排里
      // 已经评审完的 pane，人回头去看，tab 已经不在了。
      //
      // 现在 terminate 的含义是【从编排里除名】：停掉当前这一轮（不再烧额度），
      // 不再计入并发闸，不再被 wait 等待。终端留着——那是人回看过程的唯一入口。
      // worktree 与分支的去留是编排级的收尾决定，归人，不归这个动词。
      tryHerdr(["agent", "send-keys", w.pane_id, "ctrl+c"]);
      registry.update((reg) => {
        const row = Object.values(reg.sessions).find((s) => s.slug === w.slug);
        if (row) {
          row.status = "terminated";
          row.terminated_at = new Date().toISOString();
        }
      });
      return {
        worker_id: w.slug,
        method: "terminate",
        counted_in_limit: false,
        pane_id: w.pane_id,
        branch: w.worktree_branch,
        note:
          "dropped from this orchestration; its pane, tab, worktree and branch are untouched. " +
          "Tell the human where the branch is if it has work on it.",
      };
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
    // 所有 worker 共用编排容器那一个分支，所以「某一步的 diff」实际是
    // 到目前为止这个分支相对 base 的全部改动。指定 git ref 时按 ref 取。
    const upstream = ctx.steps[rest];
    if (upstream && !ctx.branch) {
      throw Object.assign(
        new Error(
          `cannot take diff_of:${rest} — this run has no branch of its own (container 'tab'). ` +
            `Use a git ref directly, e.g. diff_of:main..feature, or run with container 'worktree'.`,
        ),
        { code: "no_branch_for_diff" },
      );
    }
    // ⚠️ 【三点，不是两点】。`main..branch` 比较两个 commit 的当前状态，于是
    // 「main 上有而分支没有」的提交会显示成【分支删除了它们】——分支一旦落后于
    // main（长编排里必然发生），评审就会看到大片凭空的删除。真踩过：评审据此
    // 判了 FAIL，指控实现者删掉了一个它根本没碰过的文件。
    // `main...branch` 比较的是分支相对【共同祖先】做了什么，这才是「这次改动」。
    const ref = upstream ? `${ctx.baseRef}...${ctx.branch}` : rest;
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
    // 一个步骤可能派了多个 worker（task 传数组）。全都收进来，标上是谁说的——
    // 引擎不判断谁对谁错，那是读它的人的事。
    const parts = upstream.workers.map((w) => {
      let text = "";
      try {
        text = readWorkerResult(w.slug).text ?? "";
      } catch (e) {
        text = `(读不到：${e.code})`;
      }
      return `## ${w.title}\n\n${text}`;
    });
    const body = parts.join("\n\n---\n\n");
    const path = join(dir, `${rest.replace(/[^\w.-]/g, "_")}.md`);
    writeFileSync(path, body);
    return { path, bytes: body.length };
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
// 光看状态不够，「终态」不等于「这一轮的终态」。用 seq 当判据栽了三次：
//   1. 拿到上一轮的终态就返回 → read 读回旧答复
//   2. 基线取 sendAndConfirm 的 seq_after，而极短任务在那之前已跑完 → 永久等待
//   3. pi 的 agent start 回来时就是 done，基线取当时的 seq → 等一个不会再来的变化
//   4. 同上，但 workspace 被「看过」所以终态是 idle 不是 done，第 3 次的补丁没覆盖
// 每次都是同一个病：seq 是「状态变了几次」，而我们真正想问的是「有没有新产出」。
//
// 所以主判据换成 transcript：这一轮有没有多出 assistant 回复。
//   · 新 spawn 的 worker：派活前 transcript 是空的，基线 0，答一句就算完成
//   · send_to_worker：基线是发送前的轮次数
// 这个判据对三家 harness 一致，也不受 idle/done 之分影响。
// seq 仅作降级——transcript 还没落盘的那一小段窗口里用它兜底。
function settledNow(slug) {
  const w = findWorker(slug);
  if (!w) return null;
  const r = tryHerdr(["agent", "get", w.pane_id]);
  if (!r.ok) return null;
  const agent = r.result.agent;
  const status = agent?.agent_status;
  if (!SETTLED.has(status)) return null;
  const seq = agent.state_change_seq;

  let turns = null;
  try {
    turns = readWorkerResult(slug).assistant_turns;
  } catch {
    turns = null; // transcript 还没生成 / 还没回填路径
  }

  const done =
    turns != null
      ? turns > (w.dispatch_turns ?? 0)
      : !(w.dispatch_seq != null && seq != null && seq <= w.dispatch_seq);
  if (!done) return null;

  // 写回 herdr 报的实时状态。不写回的话 registry 永远停在 active，
  // 「这个 worker 跑完了没」就只能靠编排者自己记着（FIXME #1）。
  registry.update((reg) => {
    const row = Object.values(reg.sessions).find((x) => x.slug === slug);
    if (row) row.agent_status = status;
  });
  return turns != null ? { status, seq, turns } : { status, seq };
}

// 一次编排 = 一个 worktree workspace，挂在父 repo 下；环节是 tab，环节内并行是 pane。
// 这是用户手工建 worktree 时的布局，编排产物不该长得跟手工的不一样。
//
// 懒建 + 复用：同一个 root 的第二次 run_plan 会继续用同一个容器，
// 不会每次都在侧栏多出一个 space。
//
// 容器有【两种】，边界按「要不要写代码」划：
//   worktree —— 涉及开发的任务。新建 worktree workspace，独立分支，改动不碰主工作区。
//   tab      —— 只读的研究/探索。不新建 space，就在编排者所在的 space 里加 tab。
// 研究性任务开 worktree 是浪费（还要收尾删分支），写代码不开 worktree 则会互相踩。
let SPACE = null;
function ensureSpace(label, branch, container = "worktree") {
  if (SPACE) return SPACE;

  if (container === "tab") {
    // 就在编排者所在的 space 里干活。没有 pane 就没有「当前 space」——
    // CLI 直连的会话不在任何 workspace 里，明确报错好过静默改成新建 space。
    if (!IDENTITY.paneId) {
      throw Object.assign(
        new Error(
          "container 'tab' needs the orchestrator to be inside a herdr workspace, " +
            "but this session has no pane. Use container 'worktree', or run the orchestrator inside herdr.",
        ),
        { code: "no_current_space" },
      );
    }
    const pane = tryHerdr(["pane", "get", IDENTITY.paneId]);
    const wsId = pane.ok ? pane.result.pane?.workspace_id : null;
    if (!wsId) {
      throw Object.assign(new Error(`cannot resolve the workspace of pane ${IDENTITY.paneId}`), {
        code: "no_current_space",
      });
    }
    const w = tryHerdr(["workspace", "get", wsId]);
    SPACE = {
      workspaceId: wsId,
      checkoutPath: null, // 就在仓库本体里，只读任务不需要隔离
      branch: null,
      rootTabId: null, // 不复用别人的 tab，每个环节都新建
      tabsUsed: 1,
      container: "tab",
      label: w.ok ? w.result.workspace?.label : null,
    };
    registry.putOrchestration(ROOT, { workspace_id: wsId, container: "tab", label });
    log(`space reused (tab mode) ws=${wsId}`);
    return SPACE;
  }

  const existing = registry.getOrchestration(ROOT);
  if (existing?.workspace_id) {
    // 上一轮建过。确认它还在——herdr 重启后 workspace id 会变，那就得重建。
    const w = tryHerdr(["workspace", "get", existing.workspace_id]);
    if (w.ok) {
      SPACE = {
        workspaceId: existing.workspace_id,
        checkoutPath: existing.checkout_path,
        branch: existing.branch,
        rootTabId: existing.root_tab_id,
        tabsUsed: existing.tabs_used ?? 0,
        container: existing.container ?? "worktree",
      };
      return SPACE;
    }
  }
  const made = createOrchestrationSpace({ repo: REPO, label, branch });
  SPACE = { ...made, tabsUsed: 0, container: "worktree" };
  registry.putOrchestration(ROOT, {
    workspace_id: made.workspaceId,
    checkout_path: made.checkoutPath,
    branch: made.branch,
    root_tab_id: made.rootTabId,
    container: "worktree",
    label,
  });
  log(`space created ws=${made.workspaceId} branch=${made.branch} checkout=${made.checkoutPath}`);
  return SPACE;
}

// 编排引擎。【刻意保持哑】：只做五件事——渲染模板、派活、等完成、取产物、
// 把产物塞进下一步。它不知道 impl / review 是什么意思，换个计划就干完全不同的事。
//
// 计划的形状只有两条规则：
//   · 步骤之间【串行】——后一步通常要等前一步的产物
//   · 步骤【内部】并行——task 给数组就并行派几个
// 不需要额外的并发声明，也就没有额外要记的概念。
async function runPlan({ steps, base_ref: baseRef = "main", label, branch, mode = "rex", container }) {
  assertCanSpawn();
  if (!Array.isArray(steps) || steps.length === 0) {
    throw Object.assign(new Error("plan needs a non-empty steps array"), { code: "empty_plan" });
  }

  // container 由 mode 推导，调用方不用声明两遍；显式给 container 时以它为准（逃生口）。
  const modeSpec = getMode(mode);
  const useContainer = container || modeSpec.container;
  const runLabel = label || steps[0]?.id || "orchestration";
  // 容器名带上模式：侧栏里一眼看出这是哪种编排。
  const spaceLabel = `${modeSpec.label || mode} · ${runLabel}`;
  const space = ensureSpace(spaceLabel, branch, useContainer);
  const id = `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  // 所有 worker 都在这个 worktree 的 checkout 里干活，共用一个分支。
  const workCwd = space.checkoutPath || REPO;
  const ctx = { runId: id, repo: REPO, baseRef, branch: space.branch, steps: {} };
  const results = [];
  log(`plan start run=${id} steps=${steps.length} ws=${space.workspaceId}`);

  // ---- tab 一次建齐 ----
  //
  // 以前是跑到哪一步建哪个 tab，于是人在侧栏只看得到「已经发生的部分」，
  // 看不出这次编排一共几步、后面还有什么。整个计划的形状在第一秒就该是可见的。
  //
  // 序号跨 run_plan 连续（从 space.tabsUsed 起算）：同一个容器里第二次 run_plan
  // 要是又从 1 开始，侧栏就会出现两个「1 xxx」，谁也分不清哪个是哪次。
  const stages = [];
  const startNo = space.tabsUsed;
  try {
    for (const [index, step] of steps.entries()) {
      const stepId = step.id ?? String(index);
      // worktree 模式下 workspace 名已经带了「模式 · 任务」，tab 不必重复；
      // tab 模式的 tab 跟人自己的 tab 混在一个 space 里，必须带全名才分得清。
      const no = startNo + index + 1;
      const baseLabel =
        space.container === "tab"
          ? `${spaceLabel} · ${no} ${step.title || stepId}`
          : `${no} ${step.title || stepId}`;
      const opened = openStageTab({
        workspaceId: space.workspaceId,
        // 第一个环节复用容器自带的那个 tab，否则会白白多出一个空 tab。
        label: `${baseLabel} ☐`,
        reuseTabId: space.tabsUsed === 0 ? space.rootTabId : null,
      });
      space.tabsUsed += 1;
      stages.push({ ...opened, baseLabel, stepId });
    }
  } catch (e) {
    results.push({ step: "(tabs)", ok: false, error: e.code || "tab_failed", message: e.message });
    return { run: id, workspace_id: space.workspaceId, completed: false, stopped_at: "(tabs)", results };
  }

  // 标签存进 registry：状态要能【回退】（review 打回 impl 时 impl 那个 tab 从 ✓
  // 退回 ⋯），而回退发生在这次 run_plan 返回【之后】，局部变量那时已经没了。
  registry.putOrchestration(ROOT, {
    tabs_used: space.tabsUsed,
    stages: {
      ...(registry.getOrchestration(ROOT)?.stages ?? {}),
      ...Object.fromEntries(
        stages.map((s) => [s.tabId, { label: s.baseLabel, step: s.stepId, status: "pending" }]),
      ),
    },
  });

  // 读-改-写在一把锁里，理由同 markStageRunning。
  function recordStage(tabId, status) {
    registry.update((reg) => {
      const stage = reg.orchestrations[ROOT]?.stages?.[tabId];
      if (stage) stage.status = status;
    });
  }

  for (const [index, step] of steps.entries()) {
    const stepId = step.id ?? String(index);
    const stage = stages[index];
    const stageLabel = stage.baseLabel;
    const tasks = Array.isArray(step.task) ? step.task : [step.task];
    const profiles = Array.isArray(step.profile) ? step.profile : [step.profile];

    if (!profiles.length || profiles.some((x) => !x)) {
      throw Object.assign(new Error(`step ${stepId}: profile is required`), { code: "bad_step" });
    }
    if (!tasks.length || tasks.some((t) => !String(t ?? "").trim())) {
      throw Object.assign(new Error(`step ${stepId}: every task must be non-empty`), { code: "bad_step" });
    }
    // profile 与 task 都可以是数组，规则对称：
    //   一对一 → 各派各的；一对多 / 多对一 → 广播；多对多但长度不等 → 拒绝（意图不明）
    if (profiles.length > 1 && tasks.length > 1 && profiles.length !== tasks.length) {
      throw Object.assign(
        new Error(`step ${stepId}: ${profiles.length} profiles vs ${tasks.length} tasks — give equal counts or one of each`),
        { code: "bad_step" },
      );
    }
    const n = Math.max(profiles.length, tasks.length);
    const pick = (arr, i) => (arr.length === 1 ? arr[0] : arr[i]);

    let attached = null;
    if (step.attach) {
      try {
        attached = resolveArtifact(step.attach, ctx);
      } catch (e) {
        results.push({ step: stepId, ok: false, error: e.code || "attach_failed", message: e.message });
        return { run: id, workspace_id: space.workspaceId, completed: false, stopped_at: stepId, results };
      }
    }

    // 轮到这一步了：☐ → ⋯
    setStageStatus(stage.tabId, stageLabel, "running");
    recordStage(stage.tabId, "running");

    const spawned = [];
    for (let i = 0; i < n; i += 1) {
      const profileName = pick(profiles, i);
      const spec = applyProfile({ profile: profileName });
      const vars = { attached: attached?.path ?? "", i: i + 1, n };
      const title = render(step.title ? `${step.title}-${i + 1}` : `${profileName}-${stepId}`, vars);

      let paneId;
      try {
        // 环节内并行 = 同一个 tab 里 split 出多个 pane。
        paneId = i === 0 ? stage.rootPaneId : splitForParallel(stage.rootPaneId, i);
      } catch (e) {
        setStageStatus(stage.tabId, stageLabel, "failed");
        recordStage(stage.tabId, "failed");
        results.push({ step: stepId, ok: false, error: e.code || "split_failed", message: e.message });
        return { run: id, workspace_id: space.workspaceId, completed: false, stopped_at: stepId, results };
      }

      try {
        const entry = startAgentInPane({
          paneId,
          cwd: workCwd,
          task: render(pick(tasks, i), vars),
          harness: spec.harness,
          role: "worker",
          root: ROOT,
          parent: ROOT,
          title,
          purpose: stepId,
          branch: space.branch,
          repo: REPO,
          workspaceId: space.workspaceId,
          tabId: stage.tabId,
          yolo: !!spec.yolo,
          model: spec.model || null,
          effort: spec.effort || null,
          readOnly: !!spec.read_only,
          prompt: spec.prompt || null,
        });
        spawned.push({ slug: entry.slug, title, profile: profileName });
      } catch (e) {
        setStageStatus(stage.tabId, stageLabel, "failed");
        recordStage(stage.tabId, "failed");
        results.push({ step: stepId, ok: false, error: e.code || "spawn_failed", message: e.message });
        log(`plan ${id} step ${stepId} spawn failed: ${e.message}`);
        return { run: id, workspace_id: space.workspaceId, completed: false, stopped_at: stepId, results };
      }
    }

    ctx.steps[stepId] = { workers: spawned, branch: space.branch };
    const settled = await waitAllWorkers(spawned.map((w) => w.slug));

    const blocked = settled.filter((x) => x.status === "blocked");
    if (blocked.length) {
      setStageStatus(stage.tabId, stageLabel, "blocked");
      recordStage(stage.tabId, "blocked");
      results.push({
        step: stepId,
        ok: false,
        status: "blocked",
        tab: stage.tabId,
        workers: blocked.map((b) => ({ worker_id: b.worker_id, title: b.title })),
      });
      log(`plan ${id} stopped: step ${stepId} blocked`);
      return {
        run: id,
        workspace_id: space.workspaceId,
        completed: false,
        stopped_at: stepId,
        reason: "a worker needs a human — read_worker mode=screen to see what it is asking",
        results,
      };
    }

    setStageStatus(stage.tabId, stageLabel, "done");
    recordStage(stage.tabId, "done");
    results.push({
      step: stepId,
      ok: true,
      tab: stage.tabId,
      attached: attached?.path,
      workers: spawned.map((w) => {
        let text = "";
        try {
          text = readWorkerResult(w.slug).text ?? "";
        } catch (e) {
          text = `(结果暂时读不到：${e.code})`;
        }
        return { worker_id: w.slug, title: w.title, profile: w.profile, result: text };
      }),
    });
    log(`plan ${id} step ${stepId} done workers=${spawned.length}`);
  }

  return {
    run: id,
    workspace_id: space.workspaceId,
    branch: space.branch,
    checkout: space.checkoutPath,
    completed: true,
    results,
  };
}

// 等一整批 worker 全部落定。waitForWorkers 是「任一完成就返回」，
// 步骤内并行要的是「全部完成」，所以在这里循环收干净。
async function waitAllWorkers(ids) {
  const pending = new Set(ids);
  const settled = [];
  while (pending.size) {
    const r = await waitForWorkers([...pending]);
    for (const s of r.settled ?? []) {
      pending.delete(s.worker_id);
      settled.push(s);
    }
    for (const u of r.unreachable ?? []) {
      pending.delete(u.worker_id);
      settled.push({ worker_id: u.worker_id, status: "unreachable", reason: u.reason });
    }
    // 一轮什么都没落定说明撞到了 wait 的兜底上限，再等下去也是白等。
    if (!(r.settled ?? []).length && !(r.unreachable ?? []).length) break;
  }
  for (const id of pending) settled.push({ worker_id: id, status: "still_running" });
  return settled;
}

// 预设 = 存好的计划模板。渲染完就交给同一个引擎，没有第二套执行路径。
async function runPreset({ preset: name, inputs = {}, base_ref: baseRef = "main" }) {
  const preset = getPreset(name);
  const missing = missingInputs(preset, inputs);
  if (missing.length) {
    throw Object.assign(
      new Error(`preset '${name}' needs: ${missing.join(", ")} (see list_presets for what each means)`),
      { code: "missing_inputs" },
    );
  }
  const steps = preset.steps.map((st) => ({
    id: st.id,
    profile: st.profile,
    title: st.title ? render(st.title, inputs) : undefined,
    branch: st.branch ? render(st.branch, inputs) : undefined,
    attach: st.attach ? render(st.attach, inputs) : undefined,
    task: Array.isArray(st.task) ? st.task.map((t) => render(t, inputs)) : render(st.task, inputs),
  }));
  const out = await runPlan({
    steps,
    base_ref: baseRef,
    label: inputs.label || name,
    branch: inputs.branch || null,
    mode: preset.mode || "rex",
  });
  return { preset: name, ...out };
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
// worker 看不到这些。run_plan / run_preset 也在里面：它们内部会 assertCanSpawn
// 而被拒，但【列在工具表里】本身就是误导——worker 会照着排一个计划再撞墙，
// 那一轮的思考全白费。不给看比给看再拒绝干净。
const WORKER_HIDDEN = new Set([
  "spawn_worker",
  "cancel_worker",
  "set_worker_limit",
  "send_to_worker",
  "wait_for_worker",
  "run_plan",
  "run_preset",
]);
const EXPOSED = IDENTITY.role === "worker" ? TOOLS.filter((t) => !WORKER_HIDDEN.has(t.name)) : TOOLS;

log(`identity: role=${IDENTITY.role} root=${ROOT} pane=${IDENTITY.paneId ?? "-"} tools=${EXPOSED.length}`);

createServer({ name: "herdgent", version: "0.1.0", tools: EXPOSED, onLog: log });
