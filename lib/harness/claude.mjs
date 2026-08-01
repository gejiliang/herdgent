// Claude Code 适配。
import { readFileSync } from "node:fs";

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

export default {
  kind: "claude",

  // 需要 herdgent 自装 SessionStart 钩子：它同时回填 session id 和 transcript_path，
  // 后者没有别的拿法（路径由 harness 内部规则决定）。
  needsHook: true,

  // 实测：agent prompt 只把文字放进输入框，不回车。官方文档称原子提交，对 claude 不成立。
  submitNeedsEnter: true,
  // 只能跑 Anthropic 自家模型，跨厂商评审要靠 pi。
  supportsModel: false,

  // 支持真正的 system prompt 注入（不是把提示词拼进用户消息）。
  supportsSystemPrompt: true,

  buildArgs({ settingsPath, yolo, prompt }) {
    const args = [];
    if (settingsPath) args.push("--settings", settingsPath);
    if (prompt) args.push("--append-system-prompt", prompt);
    if (yolo) args.push("--dangerously-skip-permissions");
    return args;
  },

  // 路径由钩子回填，不用推导。
  findTranscript(_sessionId, entry) {
    return entry?.transcript_path || null;
  },

  extractResult(path, { maxChars = 20000 } = {}) {
    let text = "";
    let turns = 0;
    let sidechains = 0;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // 写入方可能正在追加，最后一行可能是半截
      }
      // isSidechain 是 worker 内部 subagent 的产物，不是它给编排者的答复。
      if (row.isSidechain) {
        if (row.type === "assistant") sidechains += 1;
        continue;
      }
      if (row.type !== "assistant") continue;
      const t = textOf(row.message);
      if (!t) continue; // 纯工具调用的轮次没有文本
      text = t;
      turns += 1;
    }

    const truncated = text.length > maxChars;
    return {
      text: truncated ? `${text.slice(0, maxChars)}\n…[truncated]` : text,
      assistant_turns: turns,
      // herdr 看不进会话内部，这是 worker 开了多少 subagent 的唯一可见渠道。
      subagent_messages: sidechains,
      truncated,
    };
  },
};
