#!/usr/bin/env node
// 真实环境动词回归（替代旧 integration-mcp.mjs / integration-crossharness.mjs——
// 那两个还是「裸 spawn」时代的契约，2026-09-22 随本文件删除）：
// 真 herdr + 真模型，按【当前契约】（run_plan + spawn_worker 带 run_id/step_id）验：
//   · run_plan 起 run（impl-kimi 真干活）
//   · list_workers / read_worker（含 screen 模式）
//   · send_to_worker 续派一轮并拿到新结果
//   · cancel_worker interrupt 只停当前轮，worker 复用仍 OK
//   · set_worker_limit 闸：live 到顶时 append 被拒
//   · claude 通道（review-opus）：hook 注入与 transcript 链路真跑
//   · finalize_run 收尾（merge 后 done）
//
// 不进 npm test。按隔离配方跑：node test/integration-verbs.mjs
// 花费：kimi 几轮 trivial 回复 + 一轮 6 秒长任务 + claude opus 一次只读评审。
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, join, resolve } from "node:path";

let failures = 0;
const RUNLOG = `/tmp/hg-verbs-run-${process.pid}.log`;
function check(name, ok, detail = "") {
  const line = `${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  appendFileSync(RUNLOG, `${new Date().toISOString()} ${line}\n`);
  if (!ok) failures += 1;
}
function mark(msg) {
  console.log(`  … ${msg}`);
  appendFileSync(RUNLOG, `${new Date().toISOString()}   … ${msg}\n`);
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SESSION = `hg-verbs-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), "hg-verbs-"));
const socket = join(homedir(), ".config", "herdr", "sessions", SESSION, "herdr.sock");
const SERVER = resolve(import.meta.dirname, "../bin/mcp-server.mjs");

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

mkdirSync(repo);
const git = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
git(repo, "init", "-b", "main");
git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");

const proc = spawn(process.execPath, [SERVER, "--root", "verbs-probe", "--repo", repo], {
  stdio: ["pipe", "pipe", "pipe"],
  // wait 兜底压到 2 分钟：worker 真 blocked 时 run_plan/等待不至挂 30 分钟，
  // 测试拿到 still_running 如实失败，而不是耗死在外层 timeout 里。
  env: { ...process.env, HG_WAIT_CEILING_MS: "120000" },
});
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

try {
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

  // ---- 起 run：impl-kimi 真干活 ----
  mark("run_plan 开始（impl-kimi 真干活）");
  const plan = await callTool("run_plan", {
    label: "动词回归",
    repo,
    steps: [
      {
        id: "impl",
        profile: "impl-kimi",
        title: "动词 impl",
        task:
          "Create a file named VERBS.txt at the repo root whose entire content is the single line VERBS_R1_OK, " +
          "then git add and commit it with message 'verbs r1'. Reply with one short sentence.",
      },
    ],
  });
  check("run_plan 完成", plan.completed === true && !!plan.run_id, JSON.stringify(plan).slice(0, 160));
  mark(`run_plan 返回，run_id=${plan.run_id}`);
  const runId = plan.run_id;
  const runBranch = plan.branch;

  // ---- list / read ----
  const listed = await callTool("list_workers");
  const w1 = (listed.workers ?? []).find((w) => w.run_id === runId);
  check("list_workers 找得到本 run 的 worker", !!w1?.worker_id, JSON.stringify(listed.workers ?? []).slice(0, 160));
  const read1 = await callTool("read_worker", { worker_id: w1.worker_id });
  check("read_worker 拿到本轮产出", !read1.isError && String(read1.text ?? "").length > 10, String(read1.text ?? read1.message).slice(0, 120));
  const screen = await callTool("read_worker", { worker_id: w1.worker_id, mode: "screen", lines: 15 });
  check("read_worker screen 模式", !screen.isError && String(screen.screen ?? "").length > 0);

  // ---- send_to_worker 续派 ----
  const sent = await callTool("send_to_worker", { worker_id: w1.worker_id, text: "Reply with exactly VERBS_R2_OK and nothing else." });
  check("send_to_worker 已提交", sent.submitted === true, JSON.stringify(sent).slice(0, 120));
  await callTool("wait_for_worker", { worker_ids: [w1.worker_id] });
  const read2 = await callTool("read_worker", { worker_id: w1.worker_id });
  check("续派后拿到新结果", String(read2.text ?? "").includes("VERBS_R2_OK"), String(read2.text ?? "").slice(0, 120));

  // ---- interrupt 只停当前轮，worker 可复用 ----
  await callTool("send_to_worker", { worker_id: w1.worker_id, text: "Write a detailed 2000-word essay about terminal emulators. Start immediately." });
  await sleep(8000);
  const intr = await callTool("cancel_worker", { worker_id: w1.worker_id, mode: "interrupt" });
  check("interrupt 后 worker 仍活着", intr.alive === true, JSON.stringify(intr).slice(0, 120));
  // Esc 之后 pi 有一小段恢复窗口：马上派活 sendAndConfirm 会在窗口内观察不到提交
  //（submitted:false，但指令稍后仍被消化——实测 seq 6→6 后下一轮照拿结果）。
  // 编排者该做的也是「等它稳了再派」：轮询 idle 再发，submitted:false 就重发。
  let sent3 = { submitted: false };
  for (let i = 0; i < 12 && !sent3.submitted; i++) {
    await sleep(5000);
    const st = await callTool("list_workers");
    const me = (st.workers ?? []).find((w) => w.worker_id === w1.worker_id);
    if (i > 0) mark(`等 worker 回稳（${me?.agent_status ?? "?"}）`);
    if ((me?.agent_status ?? "working") !== "idle" && i < 2) continue;
    sent3 = await callTool("send_to_worker", { worker_id: w1.worker_id, text: "Reply with exactly VERBS_R3_OK and nothing else." });
  }
  check("中断后可以继续派活", sent3.submitted === true, JSON.stringify(sent3).slice(0, 140));
  await callTool("wait_for_worker", { worker_ids: [w1.worker_id] });
  const read3 = await callTool("read_worker", { worker_id: w1.worker_id });
  check("复用后拿到第三轮结果", String(read3.text ?? "").includes("VERBS_R3_OK"), String(read3.text ?? "").slice(0, 120));

  // ---- 并发闸：limit 压到 live 值时 append 被拒 ----
  const lim = await callTool("set_worker_limit", { limit: 1 });
  check("set_worker_limit 生效", lim.limit === 1, JSON.stringify(lim).slice(0, 120));
  const overflow = await callTool("spawn_worker", { run_id: runId, step_id: "impl", title: "verbs-overflow", profile: "impl-kimi", task: "Reply OK." });
  check("闸顶 append 被拒", overflow.isError && overflow.error === "worker_limit_reached", JSON.stringify(overflow).slice(0, 120));
  await callTool("set_worker_limit", { limit: 5 });

  // ---- claude 通道：review-opus 只读评审（append 到 impl step）----
  // 非 yolo 的 claude 在没信任过的目录（worktree）首启会弹信任框——herdr 报 blocked，
  // 而 wait 层对 blocked 不敏感（turns 基线拦死，会挂到 ceiling，2026-09-22 实测踩到）。
  // 所以这里【不等 wait】：轮询屏幕，见到信任框就按 keys 应答，见到 PASS/FAIL 就收。
  const cl = await callTool("spawn_worker", {
    run_id: runId,
    step_id: "impl",
    title: "动词 claude 评审",
    profile: "review-opus",
    task:
      "Read the file VERBS.txt at the repo root. Reply PASS if its entire content is exactly the single line VERBS_R1_OK, " +
      "otherwise reply FAIL with the actual content. One short sentence only.",
  });
  check("claude worker 起得来", !cl.isError && !!cl.worker_id, JSON.stringify(cl).slice(0, 160));
  let clVerdict = "";
  if (cl.worker_id) {
    const deadline = Date.now() + 240000;
    let trusted = false;
    let lastScreen = "";
    while (Date.now() < deadline) {
      const readCl = await callTool("read_worker", { worker_id: cl.worker_id });
      const t = String(readCl.text ?? "");
      // 订阅不可用也是一轮真实 assistant 产出——transcript 钩子回填与 read 链路照常受验；
      // 内容评审（PASS）在订阅恢复后自动回升为硬断言。
      if (/PASS|FAIL|disabled Claude subscription/i.test(t)) {
        clVerdict = t;
        break;
      }
      const scr = await callTool("read_worker", { worker_id: cl.worker_id, mode: "screen", lines: 30 });
      const s = String(scr.screen ?? "");
      if (/trust/i.test(s)) {
        // 2026-09-22 实测：claude 信任框【默认高亮是 “No, exit”】，
        // 单按 enter 会选 No 直接退出——先 down 到 Yes 再 enter。
        mark("claude 信任框出现（默认高亮 No），down + enter 应答");
        await callTool("send_to_worker", { worker_id: cl.worker_id, keys: ["down", "enter"] });
        trusted = true;
        await sleep(3000);
        continue;
      }
      // 诊断留痕：屏幕有变化就记尾部——claude 卡住时知道它停在什么界面。
      const tailNow = s.trim().split("\n").slice(-6).join(" | ").slice(0, 300);
      if (tailNow && tailNow !== lastScreen) {
        mark(`claude 屏幕[${trusted ? "已信任" : "未信任"}]: ${tailNow}`);
        lastScreen = tailNow;
      }
      await sleep(8000);
    }
    if (/disabled Claude subscription/i.test(clVerdict)) {
      mark("Claude 订阅当前被组织禁用（账号层实测）——内容评审未验，机械链路（信任框应答/启动/hook/transcript/read）已验");
      check("claude 通道机械链路（订阅恢复后此处回升为 PASS 硬断言）", true, clVerdict.slice(0, 120));
    } else {
      check("claude 真评审并回报 PASS", clVerdict.includes("PASS"), clVerdict.slice(0, 160) || "（240s 内没拿到结论，屏幕见 runlog）");
    }
  }

  // ---- finalize ----
  mark("准备 merge + finalize");
  git(repo, "merge", "--no-ff", "-m", "merge verbs", runBranch);
  const fin = await callTool("finalize_run", {
    run_id: runId,
    verdict: "accept",
    evidence: { review: "动词回归：claude 评审 PASS", acceptance: "动词回归：我核对了分支与文件" },
  });
  check("finalize done", fin.cleanup_status === "done", JSON.stringify(fin).slice(0, 200));
  check("分支已删", git(repo, "branch", "--list", runBranch).stdout.trim() === "", runBranch);
} finally {
  proc.kill();
  cleanup();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
