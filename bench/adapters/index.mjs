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

// 统一的输出上限。这个值不是随手定的：网关的 Anthropic 兼容层会把 thinking
// 也算进 max_tokens，4096 时思考就能把预算吃光导致【没有最终答案】（实测
// stop_reason=max_tokens、content 里只有 thinking 块）。16384 实测正常，
// 留一倍余量取 32768，让长输出任务也不会撞顶。
export const MAX_OUTPUT_TOKENS = 32768;

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
      // 五家统一拉满 thinking。各家的档位名不同，取各自的最高档：
      //   claude/pi 是 max（low→medium→high→xhigh→max）
      //   codex 走 config.toml 的 model_reasoning_effort=max
      //   kimi 走 config.toml 的 [thinking] effort=max（它只有 low/high/max）
      //   opencode 【没有这个配置项】，只能在 model options 里透传，未必生效
      // ⚠️ 实测网关对这个模型不认 effort 参数（chat wire 下 none/low/high 的
      //    reasoning token 是 3130/3630/4218，落在单次采样噪声里），
      //    所以这更多是【配置对等】而非实际调参 —— 但对等本身要做到。
      // ⚠️ 上限是 high 不是 max：【网关只接受 low/medium/high】
      //    （实测传 max 直接 400：level "max" not supported）。
      //    另一个实测发现：codex 与 opencode 会把这个值【原样透传】给 API，所以会被拒；
      //    claude / pi 传 max 却不报错 —— 说明它们没有原样透传，而是自己映射了。
      //    也就是说「五家 effort 对等」在参数层面根本做不到，各家的处理方式不同。
      //    这里统一取网关能接受的最高档，并把这条差异记为【记录变量】。
      "--effort", "high",
    ],
    // ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN 都由 with-key.sh 注入 ——
    // 它是唯一持有密钥的地方，也是唯一知道计量代理监听在哪个端口的地方。
    // BASE_URL 不带 /v1：CC 自己会拼出 /v1/messages。
    env: () => ({
      // 【必须显式设大，否则 CC 会交白卷】。实测网关的 Anthropic 兼容层在
      // max_tokens=4096 时，模型的 thinking 就把预算吃光：stop_reason=max_tokens，
      // 返回里只有 thinking 块、text 是空字符串。调到 16384 才正常出答案。
      // CC 自己的默认值够大所以实跑没踩到，但长输出任务上这是个静默的白卷来源。
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_OUTPUT_TOKENS),
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
    // --format json：让它和 claude/codex/pi 一样走结构化输出。
    // 【不配这个就不能比协议开销】——第一轮我漏了它和 kimi，
    // 结果那两家的「放大倍数 1×」其实只是纯文本模式的产物，跟另外三家不可比。
    args: ({ prompt }) => ["run", prompt, "--model", `newapi/${MODEL}`, "--format", "json"],
    env: () => ({}),
    // --format json 下是 JSONL 事件流，最终答案在 type:"text" 事件的 part.text 里。
    // 【改了输出模式就必须同步改解析】——不改的话判分器拿到的是整坨 JSON 而不是答案，
    // 而 smoke 那种「输出里含 PONG 就算过」的检查照样会通过，问题要到判分才暴露。
    extract: (stdout) => {
      const parts = [];
      for (const e of looseJsonObjects(stripAnsi(stdout))) {
        if (e?.type === "text" && typeof e?.part?.text === "string") parts.push(e.part.text);
      }
      return { text: parts.join("").trim() || stripAnsi(stdout).trim(), usage: null };
    },
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
      "--thinking", "high",
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
      // 同 opencode：五家统一结构化输出，协议开销才有可比性
      "--output-format", "stream-json",
    ],
    env: () => ({}),
    // stream-json 下每行一个对象，答案在 role:"assistant" 的 content 里。
    // role:"meta" 那条是「怎么恢复会话」的提示，不是答案，必须排除掉。
    extract: (stdout) => {
      const parts = [];
      for (const e of looseJsonObjects(stripAnsi(stdout))) {
        if (e?.role === "assistant" && typeof e.content === "string") parts.push(e.content);
      }
      return { text: parts.join("").trim() || stripAnsi(stdout).trim(), usage: null };
    },
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
