#!/usr/bin/env node
// 起 agent 那条初始 prompt 的构造规则。纯函数，不碰 herdr。
//
// 守的是一条真踩过的线：herdr 的 `agent start` 把整条命令打进 pane 的命令行，
// 超长会被【截断】——截断的命令引号不闭合，shell 一直等着，agent 从没启动，
// herdr 等到超时报「timed out waiting for agent startup」。看起来像起不来，
// 实际是命令没提交。实测一条 3112 字节的 pi 命令被砍在 1023 字节处，
// pane 前台进程仍是 zsh。
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

process.env.HERDGENT_HOME = join(tmpdir(), "hg-openingprompt-nonexistent");
const { buildOpeningPrompt } = await import(`../lib/worker.mjs?t=${Date.now()}`);

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

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
