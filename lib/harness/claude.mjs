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

  // 提交语义：herdr ≤ 0.8.x 时 agent prompt 对 claude 只输入不回车，曾在这里标 submitNeedsEnter；
  // 0.9.0 起 prompt 自带 Enter（2026-09-08 实测 4/4），多补的回车会替人按下审批框默认项，故已删。
  // 跑的是 Anthropic 自家模型（Claude 订阅这条通道），但可以指定是哪一个。
  supportsModel: true,

  // 支持真正的 system prompt 注入（不是把提示词拼进用户消息）。
  supportsSystemPrompt: true,

  // `--allowed-tools` / `--disallowed-tools` 是 commander 的 <tools...> 变参；实测
  // 连逗号串也会吞掉随后位置参数，只有 `--` 能把 opening prompt 划出去。下一家
  // harness 接入前要重验自己的 flag 语义，不能照抄这一格。
  argvTerminator: "--",

  // 思考等级的最高档是 max。【没有 ultra】——那是 codex 才有的档位，
  // 写进来 claude 会拒绝启动。
  effortFlag(level) {
    return level ? ["--effort", level === "ultra" ? "max" : level] : [];
  },

  buildArgs({ settingsPath, model, effort, yolo, readOnly, prompt }) {
    const args = [];
    if (settingsPath) args.push("--settings", settingsPath);
    if (model) args.push("--model", model);
    if (effort) args.push(...this.effortFlag(effort));
    if (prompt) args.push("--append-system-prompt", prompt);
    if (readOnly) {
      // 三家里 claude 的只读最难做：光禁 Edit/Write 挡不住 `echo … > file`，
      // 所以 Bash 也得禁。代价是只读的 claude【跑不了任何命令】（含 git diff），
      // 评审要看的 diff 必须由编排层喂进任务里。
      // 白名单管免批准，黑名单管真禁用，两个都要——只给白名单不会禁掉其余工具。
      args.push("--allowed-tools", "Read", "Grep", "Glob");
      args.push("--disallowed-tools", "Edit", "Write", "NotebookEdit", "Bash");
    } else if (yolo) {
      args.push("--dangerously-skip-permissions");
    }
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
