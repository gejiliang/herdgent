// 起一个受管会话——standalone action 与编排 worker 共用这一条路径。
//
// 归属边界是结构性的：这里【建出来】的 workspace 才进登记表，
// 其它一切 workspace 都不在射程内。绝不按 label / agent 名去全局搜索。
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { herdr, tryHerdr, waitForShell, startAgentWhenReady } from "./herdr.mjs";
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

function newSlug() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
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

  // herdr 拒绝【含换行】的 agent 参数（invalid_agent_argument: "cannot be encoded
  // safely for the target shell"）。实测只有换行有问题——中文、引号、反引号、$ 都能过。
  // 编排者写的任务几乎必然是多行的，所以这一步是必需的，不是防御性编程。
  // 原文另存一份，压缩损失了格式时 worker 可以自己去读。
  const flatTask = String(task).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();

  // 1) 建容器
  let ws;
  let checkoutPath = null;
  if (branch) {
    ws = herdr([
      "worktree", "create",
      "--cwd", cwd,
      "--branch", branch,
      "--label", label,
      "--no-focus",
    ]);
    checkoutPath = ws.workspace?.worktree?.checkout_path ?? null;
  } else {
    ws = herdr(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
  }

  const workspaceId = ws.workspace.workspace_id;
  const paneId = ws.root_pane.pane_id;
  const workCwd = checkoutPath || cwd;

  const reclaim = () => {
    const r = branch
      ? tryHerdr(["worktree", "remove", "--workspace", workspaceId, "--force"])
      : tryHerdr(["workspace", "close", workspaceId]);
    return r.ok ? "reclaimed" : `LEAKED ${workspaceId} (${r.code})`;
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
      workspace_label: label,
      // 下面这些是【当时的】句柄，重启后会变，仅用于本次寻址，不作主键
      workspace_id: workspaceId,
      pane_id: paneId,
      worktree_branch: branch,
      checkout_path: checkoutPath,
      repo: cwd, // 原仓库路径，回收分支时要在这里执行 git
      cwd: workCwd,
      task,
      yolo,
      status: "starting",
      created_at: new Date().toISOString(),
      settings_path: settingsPath,
    });

    // 5) 起 agent。flag 一律排在位置参数之前——初始 prompt 必须是最后一个 argv。
    const agentName = uniqueAgentName(label);
    const harnessArgs = adapter.buildArgs({ cwd: workCwd, settingsPath, yolo });

    const openingPrompt =
      flatTask === String(task).trim()
        ? flatTask
        : `${flatTask} [The original task text, with its formatting intact, is at ${taskPath} — read it if the flattened version above is ambiguous.]`;

    const started = startAgentWhenReady([
      "agent", "start", agentName,
      "--kind", harness,
      "--pane", paneId,
      "--", ...harnessArgs, openingPrompt,
    ]);

    // 6) 钩子可能已经把 pending: 键换成了 claude:<uuid>，所以按 slug 找回自己那条，不按键。
    return registry.update((reg) => {
      const prev = Object.values(reg.sessions).find((s) => s.slug === slug);
      const key = prev?.key ?? pendingKey;
      reg.sessions[key] = {
        ...(prev ?? {}),
        key,
        agent_name: agentName,
        status: "active",
        // 派活基线：只有严格大于它的终态才算「这一轮结束了」。不记这个，
        // 等待方会拿到上一轮的终态立即返回（findings 第二节第 3 条）。
        dispatch_seq: started.agent?.state_change_seq ?? null,
        // herdr 侧也报告了 harness session id；两个来源应当一致，不一致时以钩子为准并留痕。
        herdr_reported_session_id: started.agent?.agent_session?.value ?? null,
        harness_session_id: prev?.harness_session_id ?? started.agent?.agent_session?.value ?? null,
      };
      return reg.sessions[key];
    });
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
  const value = r.ok ? r.result.agent?.agent_session?.value : null;
  if (!value) return null;

  registry.update((reg) => {
    const row = Object.values(reg.sessions).find((s) => s.slug === slug);
    if (row) {
      row.harness_session_id = value;
      row.session_id_source = "herdr_report";
    }
  });
  return value;
}

// 定位并解析 worker 的产出。路径来源按 harness 分：claude 靠钩子回填，
// codex 靠 session uuid 在文件名里找。
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

  try {
    return { path, ...adapter.extractResult(path, opts) };
  } catch (e) {
    throw Object.assign(new Error(`cannot read transcript ${path}: ${e.message}`), {
      code: "transcript_unreadable",
    });
  }
}

// 回收一个受管会话的容器。只按登记表里记的句柄操作，绝不按模式匹配去扫——
// `git branch -D` 跑在用户的仓库里，扫错一个就是不可逆的。
export function reclaimSession(entry, { deleteBranch = true } = {}) {
  const steps = [];

  if (entry.worktree_branch) {
    const r = tryHerdr(["worktree", "remove", "--workspace", entry.workspace_id, "--force"]);
    steps.push(r.ok ? "worktree_removed" : `worktree_remove_failed:${r.code}`);

    // worktree remove 【不删分支】（实测）。不补这一步，每次编排都在用户仓库里留一个分支。
    if (deleteBranch && entry.repo) {
      try {
        execFileSync("git", ["branch", "-D", entry.worktree_branch], {
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

  return steps;
}

// 发一条指令并【确认它真的被提交了】。
//
// 实测：herdr 的 agent prompt 只把文字放进输入框，不回车（官方文档称原子提交，
// 对 claude 不成立）。所以固定三步：prompt → enter → 验 state_change_seq 变化。
// 每接一家新 harness 都要重验这一条，别假定语义一致。
export function sendAndConfirm(target, text, { harness = "claude", timeoutMs = 8000, intervalMs = 250 } = {}) {
  const adapter = getHarness(harness);
  const before = tryHerdr(["agent", "get", target]);
  const seq0 = before.ok ? before.result.agent?.state_change_seq : null;

  herdr(["agent", "prompt", target, text]);
  // 要不要补 enter 是【每家不同】的：claude 只输入不回车，codex 自动提交。
  // 实测多余的 enter 对 codex 无害（不提交空消息），但仍按 harness 分支——
  // 下一家未必这么宽容。
  if (adapter.submitNeedsEnter) herdr(["agent", "send-keys", target, "enter"]);

  const deadline = Date.now() + timeoutMs;
  let last = seq0;
  while (Date.now() < deadline) {
    const now = tryHerdr(["agent", "get", target]);
    if (now.ok) {
      last = now.result.agent?.state_change_seq;
      if (seq0 == null || (last != null && last !== seq0)) {
        return { submitted: true, seq_before: seq0, seq_after: last };
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  // 没观察到状态变化：文字很可能还躺在输入框里。报出去，不要假装成功。
  return { submitted: false, seq_before: seq0, seq_after: last };
}
