// Pi 适配（pi 0.82.1 实测）。
//
// 三家里最好接的一个：
//   · herdr 报告的 agent_session 是 kind="path"，value 直接就是 transcript 文件的
//     完整路径——不用钩子，也不用按 uuid 去搜文件。
//   · agent start 返回时任务往往已经跑完（status=done），不像另外两家要等。
//   · 没有目录信任那一关，起来就干活。
//
// 它在三条通道里的分工是【承载其余厂商】：Anthropic 走原生 claude、OpenAI 走原生
// codex（各自吃自己的订阅），剩下的（月之暗面 / Google / DeepSeek / 智谱 / 阿里）
// 全部经 quota-proxy 由 pi 跑。所以跨厂商评审的多样性主要来自这里。
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
  kind: "pi",

  needsHook: false,
  supportsModel: true,

  supportsSystemPrompt: true,

  // `--tools` 收的是一个逗号串的单值，不会继续消费 opening prompt，所以不加 `--`。
  // 新增变参 flag 时要重验这个结论，不能因另外一家 harness 的规则而猜。
  argvTerminator: null,

  buildArgs({ sessionDir, model, effort, readOnly, prompt }) {
    // 指定 session 目录，产物就落在 herdgent 自己的状态目录下，不散落到别处。
    const args = ["--session-dir", sessionDir];
    if (model) args.push("--model", model);
    // 档位是 off/minimal/low/medium/high/xhigh/max。pi 没有 ultra。
    if (effort) args.push("--thinking", effort === "ultra" ? "max" : effort);
    if (prompt) args.push("--append-system-prompt", prompt);
    // pi 没有审批门，工具默认可用，所以 yolo 是 no-op。要限制反而得反过来做：
    // 只读评审用工具白名单，比「跳过权限」精确得多。
    if (readOnly) args.push("--tools", "read,grep,find,ls");
    return args;
  },

  // herdr 直接给路径（kind="path"），不需要推导。
  findTranscript(sessionValue, entry) {
    if (entry?.harness_session_kind === "path" && sessionValue) return sessionValue;
    // 兜底：万一 herdr 改成报 id 了，别静默返回空。
    return entry?.transcript_path || null;
  },

  extractResult(path, { maxChars = 20000 } = {}) {
    let text = "";
    let turns = 0;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type !== "message") continue;
      if (row.message?.role !== "assistant") continue;
      const t = textOf(row.message);
      if (!t) continue;
      text = t;
      turns += 1;
    }

    const truncated = text.length > maxChars;
    return {
      text: truncated ? `${text.slice(0, maxChars)}\n…[truncated]` : text,
      assistant_turns: turns,
      truncated,
    };
  },
};
