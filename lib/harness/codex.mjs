// Codex CLI 适配（codex-cli 0.145.0 实测）。
//
// 与 claude 的差异集中在四处，每一处都踩过：
//   1. 目录信任必须注入，否则每个 worktree 都卡在「Do you trust this directory?」上，
//      而 herdr 把那个界面报成 idle 而不是 blocked——编排层会以为它在待命。
//   2. 不需要 herdgent 自装钩子：herdr 的 codex integration 已经报告 session id。
//   3. agent prompt 自动提交，不用补 enter（claude 相反）。
//   4. transcript 按 session uuid 去文件名里找，不是钩子回填。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

// 目录信任是【精确路径匹配，不继承】：/Users/x/Workspace 是 trusted，
// 它的子目录照样会被问。而每个 worker 的 worktree 都是全新路径。
// 用 -c 注入而不是写 config.toml——那是用户的全局配置，不能碰。
function trustArg(cwd) {
  return `projects."${cwd}".trust_level="trusted"`;
}

export default {
  kind: "codex",

  needsHook: false,
  submitNeedsEnter: false,
  // 跑的是 OpenAI 自家模型（ChatGPT 订阅这条通道），但可以指定是哪一个。
  // 不给就用 ~/.codex/config.toml 里的默认，那是用户自己的设置。
  supportsModel: true,
  // codex 【没有】per-session 的 system prompt 注入：交互模式没这个参数，
  // ~/.codex/AGENTS.md 是全局的不能按会话改。所以 profile 的 prompt 只能
  // 降级拼进初始 user prompt（见 lib/worker.mjs），强度弱一档但有效。
  supportsSystemPrompt: false,

  // 当前所有前置 flag 都是单值，位置参数不会被吞；没有变参 flag 时 `--` 不需要。
  // 若以后加了变参 flag，必须重验，不能把这里的空值当成永久事实。
  argvTerminator: null,

  buildArgs({ cwd, model, effort, yolo, readOnly }) {
    const args = ["-c", trustArg(cwd)];
    if (model) args.push("--model", model);
    // 档位是 low/medium/high/xhigh/ultra/max，max 最高（codex 比另外两家多一个 ultra）。
    // 没有专门的 flag，只能经 -c 覆盖配置项。
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    if (readOnly) {
      // 沙箱级只读——三家里最硬的一档，模型再怎么想写都落不了盘。
      // 与 yolo 互斥：--dangerously-bypass 会把沙箱一起关掉。
      args.push("--sandbox", "read-only");
    } else if (yolo) {
      // codex 的 YOLO 同时关掉审批与沙箱，跟 claude 的 --dangerously-skip-permissions 对应。
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    return args;
  },

  // 会话文件是 <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl。
  // 文件名里带 uuid，所以拿 herdr 报告的 session id 就能定位。
  // 按年/月/日倒序找：worker 是刚起的，命中必在最新的几个目录里。
  findTranscript(sessionId) {
    if (!sessionId) return null;
    const root = join(codexHome(), "sessions");
    if (!existsSync(root)) return null;

    const desc = (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
          .reverse();
      } catch {
        return [];
      }
    };

    for (const y of desc(root)) {
      for (const m of desc(join(root, y))) {
        for (const d of desc(join(root, y, m))) {
          const dir = join(root, y, m, d);
          let files;
          try {
            files = readdirSync(dir);
          } catch {
            continue;
          }
          const hit = files.find((f) => f.includes(sessionId) && f.endsWith(".jsonl"));
          if (hit) return join(dir, hit);
        }
      }
    }
    return null;
  },

  extractResult(path, { maxChars = 20000 } = {}) {
    let text = "";
    let turns = 0;
    let toolCalls = 0;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const p = row.payload;
      if (!p || typeof p !== "object") continue;

      if (row.type === "response_item" && p.type === "function_call") toolCalls += 1;

      // task_complete 直接带 last_agent_message —— 这就是 worker 交上来的东西，
      // 比 claude 那边遍历找最后一条非 sidechain assistant 干净得多。
      if (row.type === "event_msg" && p.type === "task_complete") {
        if (typeof p.last_agent_message === "string" && p.last_agent_message.trim()) {
          text = p.last_agent_message.trim();
          turns += 1;
        }
      } else if (row.type === "event_msg" && p.type === "agent_message") {
        // 兜底：这一轮还没 task_complete 时，至少拿到最新的可见回复。
        if (typeof p.message === "string" && p.message.trim() && !text) {
          text = p.message.trim();
        }
      }
    }

    const truncated = text.length > maxChars;
    return {
      text: truncated ? `${text.slice(0, maxChars)}\n…[truncated]` : text,
      assistant_turns: turns,
      tool_calls: toolCalls,
      truncated,
    };
  },
};
