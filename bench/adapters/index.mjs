// 五个受测 harness 的启动方式与输出解析。
//
// 【这一层只描述「怎么起、怎么读」，不含任何评测语义】——任务是什么、怎么判分，
// 在 tasks/ 里；谁跑几次、怎么汇总，在 run.mjs 里。混进来就没法单独换 harness 了。
//
// 三条设计约束，都不是偏好：
//
//   1.【HOME 隔离】每个 harness 跑在自己的假 HOME 里（homes/<id>/ 的运行时副本）。
//      不只是为了不碰 GG 的配置 —— 更要紧的是屏蔽 ~/.agents/AGENTS.md 这类全局指令注入。
//      不隔离的话五家读到的系统提示量各不相同（claude 读 CLAUDE.md→AGENTS.md、
//      codex 读 ~/.codex/AGENTS.md、kimi 读 ~/.kimi-code/AGENTS.md……），
//      那测出来的是「谁的全局配置写得好」，不是 harness 本身。
//
//   2.【权限一律全开】。评测要测的是模型+harness 的指令遵守度，不是沙箱强度。
//      约束类任务（C 类）靠 prompt 里的禁令来测，靠 git status 来判，
//      不靠权限系统拦 —— 否则测的是对话框，不是能力。
//
//   3.【wire 格式不同是记录变量，不是可消除的】。claude 走 /v1/messages（Anthropic），
//      codex 走 /v1/responses，其余三家走 /v1/chat/completions。三条都实测 200，
//      但网关的协议转换质量会计到对应 harness 头上。结论里必须标明，不能假装同一条路。

import { join } from "node:path";

export const MODEL = "deepseek-v4-flash";
export const GATEWAY = "https://newapi.gejiliang.com";

// 网关同时挂着 `deepseek-v4-flash` 与 `ark-deepseek-v4-flash`（火山方舟入口）。
// 两个是不同上游，限流与工具调用支持都可能不同 —— 实验必须固定一个，别混用。

export const ADAPTERS = {
  claude: {
    id: "claude",
    bin: "claude",
    wire: "anthropic/messages",
    args: ({ prompt }) => [
      "-p", prompt,
      "--model", MODEL,
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
    ],
    // CC 认 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN，密钥不落盘。
    // BASE_URL 不带 /v1：CC 自己会拼出 /v1/messages。
    // ANTHROPIC_AUTH_TOKEN 由 with-key.sh 注入 —— 它才是唯一持有密钥的地方。
    env: () => ({
      ANTHROPIC_BASE_URL: GATEWAY,
      // 关掉一切会额外发请求或写状态的东西，减少噪声与串台。
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    }),
    extract: (stdout) => {
      const j = tryJson(stdout);
      if (!j) return { text: stdout.trim(), usage: null };
      return {
        text: typeof j.result === "string" ? j.result : JSON.stringify(j.result ?? ""),
        usage: j.usage ?? null,
        costUsd: j.total_cost_usd ?? null,
        turns: j.num_turns ?? null,
      };
    },
  },

  codex: {
    id: "codex",
    bin: "codex",
    wire: "openai/responses",
    args: ({ prompt, lastMessageFile }) => [
      "exec", prompt,
      "--model", MODEL,
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-o", lastMessageFile,
    ],
    // CODEX_HOME 是 Codex 官方的配置隔离开关，比 HOME 更准 —— 两条都设上做双保险。
    env: ({ home }) => ({ CODEX_HOME: join(home, ".codex") }),
    // --json 打的是 JSONL 事件流；最终消息用 -o 单独落文件，比从事件流里挑更稳。
    extract: (stdout, { lastMessage } = {}) => ({
      text: (lastMessage ?? "").trim() || lastJsonlText(stdout),
      usage: lastJsonlUsage(stdout),
    }),
  },

  opencode: {
    id: "opencode",
    bin: `${process.env.HOME}/.opencode/bin/opencode`,
    wire: "openai/chat",
    args: ({ prompt }) => ["run", prompt, "--model", `newapi/${MODEL}`],
    env: () => ({}),
    extract: (stdout) => ({ text: stripAnsi(stdout).trim(), usage: null }),
  },

  pi: {
    id: "pi",
    bin: "pi",
    wire: "openai/chat",
    args: ({ prompt }) => [
      "--print",
      "--provider", "quota-proxy",
      "--model", MODEL,
      "--mode", "json",
      "--no-session",
      prompt,
    ],
    env: () => ({}),
    // pi 的 --mode json 打的是【事件流】，不是一个 JSON 对象：
    // session / agent_start / turn_start / message_start / message_end / …
    // 而且实测这些对象是【空格分隔挤在一行】的，不是标准 JSONL，得按对象边界切。
    extract: (stdout) => {
      const evs = looseJsonObjects(stripAnsi(stdout));
      let text = "";
      let usage = null;
      for (const e of evs) {
        const m = e?.message;
        if (m?.role === "assistant" && Array.isArray(m.content)) {
          const t = m.content
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("");
          if (t.trim()) text = t.trim();
        }
        usage = e?.usage ?? m?.usage ?? e?.stats?.usage ?? usage;
      }
      return { text: text || stripAnsi(stdout).trim(), usage };
    },
  },

  kimi: {
    id: "kimi",
    bin: `${process.env.HOME}/.kimi-code/bin/kimi`,
    wire: "openai/chat",
    // --prompt 不接受任何权限开关：实测 `--auto` 和 `--yolo` 都报
    // "Cannot combine --prompt with ..."。说明 kimi 的 prompt 模式自带固定的权限语义。
    // ⚠️ 这条【必须在跑读写类任务前单独验证】：如果 prompt 模式压根不许调工具，
    // kimi 就只能参加只读问答类（A 类），不能参加 B/C/D/E。
    // 那不是「kimi 效果差」，是「这个入口不适合这类任务」，两者不能混为一谈。
    args: ({ prompt }) => [
      "--prompt", prompt,
      "--model", "qp/deepseek-v4-flash",
    ],
    env: () => ({}),
    extract: (stdout) => ({ text: stripAnsi(stdout).trim(), usage: null }),
  },
};

export const HARNESS_IDS = Object.keys(ADAPTERS);

// —— 解析小工具 ——

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, "").replace(/\][^]*/g, "");
}

function tryJson(s) {
  const t = stripAnsi(s).trim();
  try {
    return JSON.parse(t);
  } catch {
    // 有些 harness 会在 JSON 前后夹带横幅，退而求其次抓最外层的 {...}
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        /* 落到 null，调用方回退到原始文本 */
      }
    }
    return null;
  }
}

// 切出一段文本里所有【顶层 JSON 对象】，不管它们是换行分隔、空格分隔还是首尾相接。
// 为什么不用 split("\n") + JSON.parse：pi 实测把多个事件对象挤在同一行用空格分隔，
// 标准 JSONL 解析会整行失败，然后静默丢掉全部输出 —— 判分器就只能看到空字符串。
function looseJsonObjects(s) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(s.slice(start, i + 1)));
        } catch {
          /* 半截对象（被超时砍断的流）跳过，不让它带走整批 */
        }
        start = -1;
      } else if (depth < 0) depth = 0;
    }
  }
  return out;
}

function jsonlEvents(stdout) {
  return stripAnsi(stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function lastJsonlText(stdout) {
  const evs = jsonlEvents(stdout);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    const t =
      e?.msg?.message ??
      e?.message ??
      (typeof e?.text === "string" ? e.text : null);
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return "";
}

function lastJsonlUsage(stdout) {
  const evs = jsonlEvents(stdout);
  for (let i = evs.length - 1; i >= 0; i--) {
    const u = evs[i]?.usage ?? evs[i]?.msg?.usage ?? evs[i]?.info?.usage;
    if (u) return u;
  }
  return null;
}
