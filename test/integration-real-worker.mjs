#!/usr/bin/env node
// 真实 worker 隔离回归（2026-09-17 评估欠账，2026-09-21 补）：真 herdr + 真模型，
// 按【当前契约】跑一遍 rex/fox 全链路——
//   rex：run_plan（impl-glm 真干活）→ completed → finalize 未合并拒收 →
//        merge 后重调 done → 容器/分支收掉、底座 skipped 常设（2026-09-21 新语义）
//   fox：run_plan（explore-astra 只读）→ finalize 收本 run 的 tab，宿主 workspace 不动
//
// 不进的 npm test。按隔离配方跑（全部环境都在临时目录与命名 session 里）：
//   node test/integration-real-worker.mjs
//
// 花费：两次 trivial 的网关调用（kimi / deepseek-flash），不碰 Claude 订阅。
// 环境限制：本机 claude 默认 bypassPermissions（memory: claude-default-bypass-permissions），
// 弹不出审批框，blocked 应答路径无法真实回归——那一格只能靠契约测试与代码评审守住。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, join, resolve } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const SESSION = `hg-real-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), "hg-real-"));
const socket = join(homedir(), ".config", "herdr", "sessions", SESSION, "herdr.sock");
const SERVER = resolve(import.meta.dirname, "../bin/mcp-server.mjs");

// ---- 隔离 server（AGENTS.md 配方：env 必须擦净，HERDGENT_* 显式指到临时目录）----
const serverEnv = { ...process.env };
for (const k of Object.keys(serverEnv)) {
  if (k.startsWith("HERDR_") || k.startsWith("CLAUDE") || k.startsWith("HERDGENT_")) delete serverEnv[k];
}
serverEnv.HERDR_SESSION = SESSION;
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "config"), { recursive: true });
serverEnv.HERDGENT_HOME = home;
serverEnv.HERDGENT_STATE_DIR = join(home, "state");
serverEnv.HERDGENT_CONFIG_DIR = join(home, "config");
const server = spawn("herdr", ["server"], { env: serverEnv, stdio: "ignore" });

const repo = join(home, "repo");
function cleanup() {
  spawnSync("herdr", ["session", "stop", SESSION], { encoding: "utf8", env: { ...serverEnv, HERDR_SOCKET_PATH: socket } });
  spawnSync("herdr", ["session", "delete", SESSION], { encoding: "utf8", env: { ...serverEnv, HERDR_SOCKET_PATH: socket } });
  server.kill();
  if (existsSync(repo)) {
    const list = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const line of (list.stdout || "").split("\n")) {
      if (!line.startsWith("worktree ") || line.includes(repo)) continue;
      spawnSync("git", ["-C", repo, "worktree", "remove", "--force", line.slice(9)], { encoding: "utf8" });
    }
    spawnSync("git", ["-C", repo, "worktree", "prune"], { encoding: "utf8" });
    rmSync(join(homedir(), ".herdr", "worktrees", basename(repo)), { recursive: true, force: true });
  }
  rmSync(home, { recursive: true, force: true });
}

const upDeadline = Date.now() + 15000;
while (!existsSync(socket) && Date.now() < upDeadline) sleepSync(250);
if (!existsSync(socket)) {
  console.error("isolated herdr server never came up — aborting");
  cleanup();
  process.exit(1);
}
process.env.HERDR_SOCKET_PATH = socket;
process.env.HERDGENT_HOME = home;
process.env.HERDGENT_STATE_DIR = join(home, "state");
process.env.HERDGENT_CONFIG_DIR = join(home, "config");
delete process.env.HERDR_BIN_PATH;
if (!process.env.HERDR_SOCKET_PATH.includes(SESSION)) {
  console.error("socket sanity check failed");
  cleanup();
  process.exit(1);
}

// ---- 临时 repo 与 fox 宿主 workspace ----
mkdirSync(repo);
const git = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
git(repo, "init", "-b", "main");
git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
const herdrJson = (...args) => {
  const r = spawnSync("herdr", args, { encoding: "utf8" });
  return JSON.parse((r.stdout || "").trim() || (r.stderr || "").trim());
};
const host = herdrJson("workspace", "create", "--cwd", repo, "--label", "real-probe-host", "--no-focus").result;
const hostPane = host.root_pane.pane_id;
const hostWs = host.workspace.workspace_id;
const wsLabel = (id) => (herdrJson("workspace", "list").result.workspaces ?? []).find((w) => w.workspace_id === id)?.label ?? null;

// ---- 最小 MCP 客户端（与 stage-root-pane 同款，直连 server 进程）----
const proc = spawn(
  process.execPath,
  [SERVER, "--root", "real-probe", "--repo", repo],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HERDR_PANE_ID: hostPane }, // fox 需要「编排者当前所在」
  },
);
proc.stderr.on("data", (d) => console.error("[server stderr]", String(d).trim()));
let nextId = 1;
const pending = new Map();
let buf = "";
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
async function callTool(name, args = {}) {
  const reply = await send("tools/call", { name, arguments: args });
  const text = reply.result?.content?.[0]?.text ?? "{}";
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { isError: !!reply.result?.isError, ...body };
}
const branchExists = (name) => git(repo, "branch", "--list", name).stdout.trim() !== "";

try {
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

  // ================= rex：真 impl-glm 干活 =================
  const t0 = Date.now();
  const plan = await callTool("run_plan", {
    label: "真实回归",
    repo,
    steps: [
      {
        id: "impl",
        profile: "impl-glm",
        title: "真实回归 impl",
        task:
          "Create a file named REAL_RUN_OK.txt at the repo root whose entire content is the single line REAL_RUN_OK, " +
          "then git add and commit it with the message 'real regression'. Reply with one short sentence confirming the commit hash.",
      },
    ],
  });
  const rexMs = Date.now() - t0;
  check("rex: run_plan 真跑完", plan.completed === true && !!plan.run_id, JSON.stringify(plan).slice(0, 200));
  const runId = plan.run_id;
  const runWs = plan.workspace_id;
  const runBranch = plan.branch;
  check("rex: 分支与容器都登记了", !!runBranch && !!runWs, `branch=${runBranch} ws=${runWs}`);
  const commitInBranch = git(repo, "log", "--format=%s", "-1", runBranch).stdout.trim();
  check("rex: worktree 分支上真有 commit", /real regression/.test(commitInBranch), commitInBranch);
  console.log(`  … rex run 耗时 ${(rexMs / 1000).toFixed(0)}s`);

  // ---- finalize：未合并拒收 → merge → 重调 done ----
  const fin1 = await callTool("finalize_run", {
    run_id: runId,
    verdict: "accept",
    evidence: { review: "真实回归：分支上有预期 commit", acceptance: "真实回归：我核对了分支内容" },
  });
  check("finalize: 未合并一律拒绝", fin1.isError === true || /not merged|unmerged|refus/i.test(JSON.stringify(fin1)), JSON.stringify(fin1).slice(0, 200));
  git(repo, "merge", "--no-ff", "-m", "merge real regression", runBranch);
  const fin2 = await callTool("finalize_run", {
    run_id: runId,
    verdict: "accept",
    evidence: { review: "真实回归：分支上有预期 commit", acceptance: "真实回归：已并入 main，我核对了" },
  });
  check("finalize: 合并后重调 done", fin2.cleanup_status === "done", JSON.stringify(fin2).slice(0, 240));
  check("finalize: run 容器收掉、分支删掉", wsLabel(runWs) == null && !branchExists(runBranch), `ws=${wsLabel(runWs)} branch=${runBranch}`);
  const baseStep = (fin2.steps ?? []).find((s) => s.action === "close_base_workspace");
  check(
    "finalize: 底座 skipped（2026-09-21 常设语义，真实 herdr 验证）",
    baseStep?.status === "skipped" && /standing orchestration base/.test(baseStep?.detail ?? ""),
    JSON.stringify(baseStep),
  );
  // 本测试先建了 cwd=repo 的宿主 workspace——真 herdr 直接把它当 primary，
  // run 领养了它当底座（不是新建 “<repo> · runs”）。这正是期望行为：
  // cwd=repo 的已开 space 会被复用，不再多开一个。（GG 的对象根 space 是另一回事：
  // 它的 root cwd 不在 repo 里，当不了 source，见 findings-2026-09-21-base-permanent.md。）
  const runRow = JSON.parse(readFileSync(join(home, "state", "runs", `${runId}.json`), "utf8"));
  check(
    "finalize: run 领养宿主当底座（base=host，created_by_run=false）",
    runRow.base_workspace?.workspace_id === hostWs && runRow.base_workspace?.created_by_run === false,
    JSON.stringify(runRow.base_workspace),
  );
  check("finalize: 领养来的底座（宿主）留在侧栏", wsLabel(hostWs) === "real-probe-host", String(wsLabel(hostWs)));

  // ================= fox：只读一步，收 tab 不动宿主 =================
  const foxPlan = await callTool("run_plan", {
    mode: "fox",
    label: "真实回归 fox",
    repo,
    steps: [
      {
        id: "survey",
        profile: "explore-astra",
        title: "真实回归 survey",
        task: "Answer in one short sentence: what is the commit subject of the latest commit on the current branch of this repo?",
      },
    ],
  });
  check("fox: run_plan 真跑完", foxPlan.completed === true && !!foxPlan.run_id, JSON.stringify(foxPlan).slice(0, 200));
  check("fox: 落在宿主 workspace", foxPlan.workspace_id === hostWs, `ws=${foxPlan.workspace_id} host=${hostWs}`);
  const foxFin = await callTool("finalize_run", {
    run_id: foxPlan.run_id,
    verdict: "accept",
    evidence: { review: "真实回归 fox：答出了最新 commit 主题", acceptance: "真实回归 fox：我核对了回答" },
  });
  check("fox: finalize done", foxFin.cleanup_status === "done", JSON.stringify(foxFin).slice(0, 200));
  const hostTabs = (herdrJson("tab", "list", "--workspace", hostWs).result.tabs ?? []).map((t) => t.label);
  check("fox: 本 run 的 tab 收掉，宿主原 tab 还在", hostTabs.length === 1 && !hostTabs.some((l) => l.includes("真实回归")), hostTabs.join("|"));
} finally {
  proc.kill();
  cleanup();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
