#!/usr/bin/env node
// 起 agent 那条初始 prompt 的构造规则。纯函数，不碰 herdr。
//
// 守的是一条真踩过的线：herdr 的 `agent start` 把整条命令打进 pane 的命令行，
// 在 shell 还没启用 zle 的窗口里（规范模式）内核行缓冲约 1024 字节封顶，
// 超长尾部被【静默丢弃】——截断的命令引号不闭合，agent 从没启动，herdr
// 等到超时报「timed out waiting for agent startup」。实测（0.7.5 与 0.9.1）
// 截在 1022–1023 字节；隔离会话确定性复现：1020 完整、1040 截断。
// 所以预算管的是【整条敲入命令】（kind+flags+profile 提示词+初始 prompt），
// 不是只量任务体——旧实现只限任务体 1200，任务体 613~1200 的内联分支照样
// 把总长推过 1024（2026-09-22 生产事故：prefix 408 + 任务 1187 = 1595）。
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

process.env.HERDGENT_HOME = join(tmpdir(), "hg-openingprompt-nonexistent");
const worker = await import(`../lib/worker.mjs?t=${Date.now()}`);
const { buildOpeningPrompt, composeOpeningPrompt, typedCommandBytes } = worker;
const { getHarness } = await import(`../lib/harness/index.mjs?t=${Date.now()}`);

const TASK_PATH = "/tmp/hg/sessions/abc/task.md";
const withSysPrompt = { supportsSystemPrompt: true }; // claude / pi
const noSysPrompt = { supportsSystemPrompt: false }; // codex
const PROFILE_PROMPT = "You are an implementer working inside an orchestration. ".repeat(6);

const flatten = (s) => String(s).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();

// ---- 短任务：照旧直接进 argv ----
{
  const task = "把 README 里的错别字改掉";
  const out = buildOpeningPrompt({ task, flatTask: flatten(task), taskPath: TASK_PATH, adapter: withSysPrompt, prompt: null });
  check("短任务直接进 argv", out.includes("错别字"), out.slice(0, 40));
  check("短任务且无格式损失时不附路径", out === task, out);
}

// ---- 长任务：argv 里【只有】路径，任务正文一个字都不进去 ----
{
  const task = "详细任务说明。".repeat(300); // 约 6300 字节
  const flat = flatten(task);
  const out = buildOpeningPrompt({ task, flatTask: flat, taskPath: TASK_PATH, adapter: withSysPrompt, prompt: null });

  check("长任务不进 argv", !out.includes("详细任务说明"), `${out.length} 字符`);
  check("长任务给出文件路径", out.includes(TASK_PATH), out.slice(0, 60));
  check(
    "结果远小于截断阈值",
    Buffer.byteLength(out, "utf8") < 400,
    `${Buffer.byteLength(out, "utf8")} 字节`,
  );
}

// ---- 真实的那次失败：2536 字节中文任务 ----
{
  const task = "让 bin/session-start.mjs 起的会话也走 profile。\n".repeat(40);
  const before = Buffer.byteLength(flatten(task), "utf8");
  const out = buildOpeningPrompt({ task, flatTask: flatten(task), taskPath: TASK_PATH, adapter: withSysPrompt, prompt: null });
  check(
    "复现那次失败的规模后仍然短",
    before > 2000 && Buffer.byteLength(out, "utf8") < 400,
    `任务 ${before} 字节 → 命令 ${Buffer.byteLength(out, "utf8")} 字节`,
  );
}

// ---- codex 没有 system prompt，profile 提示词得随行 ----
{
  const task = "详细任务说明。".repeat(300);
  const out = buildOpeningPrompt({
    task,
    flatTask: flatten(task),
    taskPath: TASK_PATH,
    adapter: noSysPrompt,
    prompt: PROFILE_PROMPT,
  });
  check("codex 的 profile 提示词仍然随行", out.includes("You are an implementer"), out.slice(0, 50));
  check("codex 长任务同样只给路径", !out.includes("详细任务说明") && out.includes(TASK_PATH));
  // 提示词本身有几百字节，但仍必须远低于观察到的截断点
  check("加上提示词也没超", Buffer.byteLength(out, "utf8") < 1024, `${Buffer.byteLength(out, "utf8")} 字节`);
}

// ---- 支持 system prompt 的 harness 不该把提示词塞进用户消息 ----
{
  const task = "短任务";
  const out = buildOpeningPrompt({
    task,
    flatTask: task,
    taskPath: TASK_PATH,
    adapter: withSysPrompt,
    prompt: PROFILE_PROMPT,
  });
  check("claude / pi 的提示词走 system 通道，不进 argv", !out.includes("You are an implementer"), out.slice(0, 40));
}

// ---- 2026-09-22 事故回归：任务体 1187 字节（≤旧阈值 1200），旧逻辑会内联 ----
// 事故形状：pi 前缀（flags+profile 提示词）408 字节 + 任务 1187 = 1595，
// 在未就绪的 pane 里被规范行缓冲砍在 1022。新逻辑必须按【总长】回退到只传路径。
{
  const task = "调".repeat(396); // 1188 字节，在旧阈值 1200 以内
  const FIXED_408 = 408; // 事故当时的 pi 前缀字节数
  check("事故任务体确实落在旧阈值内（否则本用例不构成回归）", Buffer.byteLength(task, "utf8") <= 1200, `${Buffer.byteLength(task, "utf8")} 字节`);
  const out = buildOpeningPrompt({ task, flatTask: task, taskPath: TASK_PATH, adapter: withSysPrompt, prompt: null, fixedBytes: FIXED_408 });
  check("事故规模任务不进 argv", !out.includes("调"), out.slice(0, 60));
  check("事故规模任务只给路径", out.includes(TASK_PATH), out.slice(0, 60));
}

// ---- 预算装不下 path-only 最小形态时：显式失败，不静默截断 ----
{
  const task = "长任务。".repeat(200);
  let threw = null;
  try {
    buildOpeningPrompt({ task, flatTask: task, taskPath: TASK_PATH, adapter: withSysPrompt, prompt: null, fixedBytes: 900 });
  } catch (e) {
    threw = e;
  }
  check("固定部分吃掉预算时报 opening_prompt_overflow", threw?.code === "opening_prompt_overflow", threw?.message || "未抛错");
}

// ---- typedCommandBytes：引号后字节的上界估算 ----
{
  // "pi"(2)+3 + "--model"(7)+3 + "m x"(3)+3 = 21
  check("基础计算", typedCommandBytes("pi", ["--model", "m x"]) === 21, String(typedCommandBytes("pi", ["--model", "m x"])));
  // "it's" 含 1 个单引号：4 字节 + 引号对 2 + 分隔 1 + 转义展开 3 = 10；加上 "pi" 的 5
  check("单引号按转义膨胀", typedCommandBytes("pi", ["it's"]) === 15, String(typedCommandBytes("pi", ["it's"])));
}

// ---- 三家 harness 的最坏现实组合：整条敲入命令必须都在预算内 ----
// profile 提示词取现有 profile 表最长一档（impl 系，~420 字节），路径取真实长度，
// 只读档（flags 最多）。再长的 profile 会触发 opening_prompt_overflow 显式失败——
// 那是护栏不是 bug；这里锁住「现实 profile 永远撞不到那条报错」。
{
  const LONG_PROFILE =
    "You are an implementer working inside an orchestration. Do exactly the change you were asked for and nothing else — no drive-by refactors, no unrelated cleanups, no reformatting untouched code. When done, git add and commit with a short message. Then state in one paragraph what you changed and how you verified it.";
  const LONG_TASK = "详细任务说明。".repeat(300);
  const STATE = "/Users/gejiliang/.herdgent/state/sessions/abcdefghijkl/harness-sessions";
  const TASK_FILE = "/Users/gejiliang/.herdgent/state/sessions/abcdefghijkl/task.md";
  for (const kind of ["pi", "claude", "codex"]) {
    const adapter = getHarness(kind);
    const harnessArgs = adapter.buildArgs({
      cwd: "/Users/gejiliang/GBase/workspaces/Trade",
      settingsPath: "/Users/gejiliang/.herdgent/state/sessions/abcdefghijkl/settings.json",
      yolo: false,
      model: kind === "pi" ? "quota-proxy/ark-deepseek-v4-flash" : "gpt-or-sonnet-class-name",
      effort: "high",
      readOnly: true,
      prompt: LONG_PROFILE,
      sessionDir: STATE,
    });
    const opening = composeOpeningPrompt({
      harness: kind,
      adapter,
      harnessArgs,
      task: LONG_TASK,
      flatTask: LONG_TASK,
      taskPath: TASK_FILE,
      prompt: LONG_PROFILE,
    });
    const fixed = [...harnessArgs, ...(adapter.argvTerminator ? [adapter.argvTerminator] : [])];
    const total = typedCommandBytes(kind, [...fixed, opening]);
    check(`${kind} 最坏组合整条命令在预算内`, total <= 960, `${total} 字节`);
    check(`${kind} 超长任务不进 argv`, !opening.includes("详细任务说明"));
  }
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
