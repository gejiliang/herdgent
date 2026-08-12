// Worker profile：把「用什么跑」收成一个名字。
//
// 没有它的话，编排者每次派活都要自己拼 harness / model / yolo / read_only 四个参数，
// 组错了还不会立刻报错（比如给只读评审忘了 read_only，它就真去改代码了）。
//
// profile 是【配置不是代码】：它描述用什么工具跑，不描述谁评审谁。
// 后者是编排语义，只能活在 skill 里（见 AGENTS.md 的编排层边界）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configRoot } from "./paths.mjs";

// 三条接入通道，profile 就是它们的具体配置：
//   claude → Claude 订阅，跑 Anthropic 自家模型
//   codex  → ChatGPT 订阅，跑 OpenAI 自家模型 ← 【现在没有可用凭据，见下】
//   pi     → quota-proxy 网关，承载其余所有厂商
//
// 【OpenAI 整条线下线】（2026-08-12 实测，证据见 docs/model-availability-2026-08-12.md）：
// ChatGPT 订阅到期不续，原生 codex 报 "You've hit your usage limit"，而网关那侧的
// gpt-5.6-* 本来就是拿同一份 ChatGPT OAuth 凭据兑的，于是一起断——terra 报
// model_cooldown（reset 682 小时），sol 报 unknown provider。【绕不过去：两条路是同一个订阅】。
// 所以 profile 表里暂时没有任何 codex 条目，也没有任何 gpt-* 模型。
// 【lib/harness/codex.mjs 保留不动】——适配是动词，凭据是配置；订阅哪天回来，
// 在这里加回 impl-gpt / review-gpt 两条即可，代码一行不用改。
//
// 【herdgent 不维护模型表】。本地任何一份「可用模型」清单都会骗人——实测同一时刻
// 就有四层互不一致：pi 的静态 models.json、GG 写的 extension 从网关拉的活目录、
// `pi --list-models` 的输出（不触发 refresh，永远是静态那份）、以及网关的真实白名单。
// kimicode-k3-256k 在前三层都查不到，网关却认；claude-opus-4-8 前三层都有，网关报
// model_not_found。所以模型名在这里【原样透传】，由网关裁决，失败时如实报因。
//
// 模型名必须带 provider 前缀（pi）：不带前缀时 pi 做模糊匹配，可能命中另一个
// provider 的同名模型然后报 "No API key found for ..."，任务静默不执行。
// profile 自带的提示词。这是「规则固化进配置」的另一半：worker 的行为约束不靠
// 编排者在任务里嘱咐，而是随 profile 一起注入——claude / pi 走真的 system prompt，
// codex 没有那个能力，降级拼进初始消息（见 lib/worker.mjs）。
const IMPLEMENTER_PROMPT =
  "You are an implementer working inside an orchestration. Do exactly the change you were asked for and nothing else — " +
  "no drive-by refactors, no unrelated cleanups, no reformatting untouched code. " +
  "When done, git add and commit with a short message. " +
  "Then state in one paragraph what you changed and how you verified it. " +
  "If the task is ambiguous, make the smallest reasonable interpretation and say which one you took.";

const REVIEWER_PROMPT =
  "You are an independent reviewer. You did not write this code and you must not change any file. " +
  "Judge the diff against the acceptance criteria you were given, item by item, and state PASS or FAIL for each with a reason. " +
  "Report real defects, not style preferences. If something is fine, say so plainly instead of inventing concerns.";

const EXPLORER_PROMPT =
  "You are exploring a codebase to answer a question. Read what you need, change nothing. " +
  "Answer with what you actually found, citing file paths and line numbers. " +
  "If you could not determine something, say so instead of guessing.";

// 命名是【角色在前，模型在后】：先决定派谁去干什么，再看用哪家的脑子。
// 反过来（codex-impl）会让人先想工具后想角色，而角色才是编排要决定的东西。
//
// 两条硬约束，都不是偏好问题：
//
//   1.【Claude 模型做 agent 只能走原生通道】。网关（quota-proxy）代理的 Claude
//      只适合简单调用，不能拿来跑 agent。所以任何 claude-* 模型的 profile
//      harness 必须是 claude，绝不是 pi。test/profiles.mjs 守着这条。
//
//   2.【Claude 订阅是最金贵的池子】，优先留给评审与需求分析/设计（后者是编排者
//      自己在干）。所以实现主力是 impl-kimi 与 impl-glm，impl-sonnet 只是
//      fallback —— 前两个都不可用时才派它。这条是【调度语义】，活在 skill 里，
//      profile 只在 description 里标明，引擎不认识「fallback」这个概念。
//
// 分档：实现用 S 级（够强、能持续跑），评审用 S+ 级（要抓实现方没看见的问题，
// 便宜模型在这一步省不出钱）。
// 【评审档现在只有一个 S+】：GPT 下线后，网关上剩下的 S+ 全是 Claude 模型，
// 而 Claude 做 agent 只能走原生通道（约束 1）。所以第三家评审 review-deepseek
// 是 A 级——这是被迫降档，不是重新定档。订阅回来就该把 S+ 补回去。
//
// `vendor` 是【谁家的模型】，不是谁家的通道：review-kimi 与 review-deepseek 都走 pi
// 却是两家，impl-sonnet 与 review-opus 走两条不同配置却是同一家。跨厂商评审看的是这个字段。
// 它是**事实标注**不是编排语义——引擎不认识「该配谁」，只是把厂商如实标出来，
// 让 skill 里那条「评审换一家」的规则有个能对照的东西，也让测试守得住。
// 模型名推不出来（sonnet 与 opus 都是 anthropic），所以只能显式写。
const BUILTIN = {
  // ---- 实现（S 级，全部拉满思考等级）----
  "impl-kimi": {
    harness: "pi",
    vendor: "moonshot",
    model: "quota-proxy/kimicode-k3-256k",
    effort: "max",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer — Kimi Code K3 256K via pi.",
  },
  "impl-glm": {
    harness: "pi",
    vendor: "zhipu",
    model: "quota-proxy/ark-glm-5.2",
    effort: "max",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer — GLM-5.2 (Zhipu) via pi. Second vendor, so review can cross vendors.",
  },
  "impl-sonnet": {
    harness: "claude",
    vendor: "anthropic",
    model: "sonnet",
    effort: "max",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description:
      "Implementer — Claude Sonnet 5 on native Claude Code. FALLBACK ONLY: dispatch this " +
      "only when impl-kimi and impl-glm are both unavailable. It spends the Claude " +
      "subscription, which is reserved for review and design.",
  },

  // ---- 评审（只读由各家引擎强制，见 lib/harness/*.mjs）----
  "review-opus": {
    harness: "claude",
    vendor: "anthropic",
    model: "opus",
    effort: "max",
    prompt: REVIEWER_PROMPT,
    read_only: true,
    description: "Reviewer — Claude Opus 5 on native Claude Code. Cannot run commands: feed it the diff.",
  },
  "review-deepseek": {
    harness: "pi",
    vendor: "deepseek",
    model: "quota-proxy/deepseek-v4-pro",
    effort: "max",
    prompt: REVIEWER_PROMPT,
    read_only: true,
    description: "Reviewer — DeepSeek V4 Pro via pi. Third vendor for fan-out review.",
  },
  "review-kimi": {
    harness: "pi",
    vendor: "moonshot",
    model: "quota-proxy/kimicode-k3",
    effort: "max",
    prompt: REVIEWER_PROMPT,
    read_only: true,
    description: "Reviewer — Kimi Code K3 (1M context) via pi.",
  },

  // ---- 探索 ----
  // 定位是【快 + 便宜】，用在大扇出粗筛上。所以【不拉思考等级】——
  // 拉满就既不快也不便宜了，那就该直接派评审档的模型。
  "explore-deepseek": {
    harness: "pi",
    vendor: "deepseek",
    model: "quota-proxy/ark-deepseek-v4-flash",
    prompt: EXPLORER_PROMPT,
    read_only: true,
    description: "Explorer — DeepSeek V4 Flash via pi. Fast and cheap, for wide fan-outs.",
  },
};

// 用户自定义放 ~/.herdgent/config/profiles.json，键名相同即覆盖内置。
function userProfiles() {
  try {
    const raw = JSON.parse(readFileSync(join(configRoot(), "profiles.json"), "utf8"));
    return raw && typeof raw === "object" ? raw.profiles ?? raw : {};
  } catch {
    return {}; // 没配置不是错误
  }
}

export function allProfiles() {
  const user = userProfiles();
  const merged = {};
  for (const [name, p] of Object.entries(BUILTIN)) merged[name] = { ...p, source: "builtin" };
  for (const [name, p] of Object.entries(user)) {
    merged[name] = { ...(merged[name] ?? {}), ...p, source: merged[name] ? "user-override" : "user" };
  }
  return merged;
}

export function getProfile(name) {
  const p = allProfiles()[name];
  if (!p) {
    throw Object.assign(
      new Error(`unknown profile '${name}' (available: ${Object.keys(allProfiles()).join(", ")})`),
      { code: "unknown_profile" },
    );
  }
  return p;
}

// ---- 独立会话（session-start action）用哪个 profile ----
//
// `herdr plugin action invoke` 没有传参机制（只有 --plugin 和 ACTION_ID），
// 所以 profile 不能靠命令行参数进来，只能放 herdr 注入的插件配置目录
// （HERDR_PLUGIN_CONFIG_DIR）下的 config.json，键 `session_start_profile`。
// 读法参照已删除的 bin/orchestrate.mjs 的 configuredLimit()。
//
// 默认值选 impl-kimi，理由：
//   · 独立会话是让人往里派活的交互会话，需要 yolo + 完整 prompt + 拉满思考，
//     即一个实现档 profile——review-*/explore-* 全是 read_only，派了活也改不了代码。
//   · impl-sonnet 是 fallback 专用（烧 Claude 订阅额度，那池子留给评审与设计），不能做默认。
//   · 于是只剩 impl-kimi 与 impl-glm，取上下文更大的那个。
// 【原来选的是 impl-gpt】，理由是它走原生 Codex 订阅、比经网关的 impl-kimi 少一层外部依赖。
// 那条理由随 ChatGPT 订阅到期一起作废了（2026-08-12）：现在两个实现主力都在网关后面，
// 「少一层依赖」已经没得选，网关挂了独立会话就起不来。
export const DEFAULT_SESSION_START_PROFILE = "impl-kimi";

// 纯函数：输入插件配置目录路径（可为 undefined），输出 profile 名。
// 读不到 / 坏 JSON / 没写这个键都回默认——没配置不是错误。
// 【不做存在性校验】：配置里写了不存在的名字会原样返回，由调用方的
// applyProfile 在起会话之前抛出 unknown_profile，而不是在这里静默退回默认。
export function sessionStartProfile(configDir) {
  if (!configDir) return DEFAULT_SESSION_START_PROFILE;
  try {
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    const name = cfg?.session_start_profile;
    return typeof name === "string" && name.trim() ? name.trim() : DEFAULT_SESSION_START_PROFILE;
  } catch {
    return DEFAULT_SESSION_START_PROFILE;
  }
}

// 「用什么跑」这四个维度【只认 profile】，调用方覆盖不了。
//
// 早先的版本允许显式参数压过 profile，理由是「临时改一处不该被迫另建 profile」。
// 那是错的：能覆盖就意味着 profile 不是唯一真源，分工就管不住——编排者可以绕过
// 分工直接挑模型，而分工恰恰是人要掌握的那一层（哪家干活、哪家评审、谁烧谁的额度）。
// 要换配置就改 profile（~/.herdgent/config/profiles.json 里加一条即可），
// 那是留痕的、可复用的；临时覆盖是不留痕的。
export function applyProfile(args) {
  const p = getProfile(args.profile);
  return {
    ...args,
    harness: p.harness,
    model: p.model ?? null,
    effort: p.effort ?? null,
    yolo: p.yolo ?? false,
    read_only: p.read_only ?? false,
    prompt: p.prompt ?? null,
    profile_applied: args.profile,
    profile_wants_branch: !!p.wants_branch,
  };
}
