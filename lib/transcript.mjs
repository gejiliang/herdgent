// 读 harness 的 transcript 拿 worker 的结果。
//
// 为什么读文件而不是让 worker 汇报：worker 是一个【普通的】harness 会话，
// 它不知道自己在被编排。零约定、零注入，也就没有「worker 忘了按格式回复」这种失败模式。
//
// Claude Code 的 transcript 是 ~/.claude/projects/<slug>/<session-id>.jsonl，
// 路径由 SessionStart 钩子回填进 registry（payload.transcript_path）。
import { readFileSync } from "node:fs";

// 一行一个 JSON 对象。坏行跳过而不是整体失败——写入方可能正在追加，
// 最后一行可能是半截。
function* readLines(path) {
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * 最后一条主线 assistant 回复 —— 也就是 worker 交上来的东西。
 *
 * isSidechain 的消息是 worker 内部 subagent 的产物，不是它给编排者的答复，必须排除。
 */
export function lastAssistantText(transcriptPath, { maxChars = 20000 } = {}) {
  let text = "";
  let turns = 0;
  let sidechains = 0;

  for (const row of readLines(transcriptPath)) {
    if (row.isSidechain) {
      if (row.type === "assistant") sidechains += 1;
      continue;
    }
    if (row.type !== "assistant") continue;
    const t = textOf(row.message);
    if (!t) continue; // 纯工具调用的轮次没有文本，跳过
    text = t;
    turns += 1;
  }

  const truncated = text.length > maxChars;
  return {
    text: truncated ? `${text.slice(0, maxChars)}\n…[truncated]` : text,
    assistant_turns: turns,
    // worker 内部开了多少 subagent。herdr 看不进会话内部，这是唯一的可见渠道。
    subagent_messages: sidechains,
    truncated,
  };
}
