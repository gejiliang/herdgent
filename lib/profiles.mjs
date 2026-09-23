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

// 【2026-09-22 起 harness 只用 pi】（GG 定）：三条通道塌成一条——
//   · claude → Claude 订阅：【组织已禁用】（2026-09-22 三路径实测，
//     "Your organization has disabled Claude subscription access"，见
//     docs/findings-2026-09-22-real-verbs.md）→ impl-sonnet / review-opus 移出表。
//   · codex → ChatGPT 订阅：2026-08-12 到期不续（见下），无原生 codex 条目。
//   · pi → quota-proxy 网关：现在承载【全部】厂商。
// lib/harness/claude.mjs 与 codex.mjs 都【保留不动】——适配是动词，凭据是配置；
// 订阅回来在这里加回条目即可，代码一行不用改。
//
// 【OpenAI 线 2026-09 回归】：2026-08-12 ChatGPT 订阅到期整线下线
//（docs/model-availability-2026-08-12.md）；2026-09-22 qp2 的 /v1/models 重新出现
// gpt-6-astra / gpt-5.6-*，连通与评审小测均过。GG 2026-09-23 定调：
// Astra 只负责评审，是唯一 S+（思考强度 mid），不做实现。新凭据的性质
//（稳定订阅还是 key 额度）未经时间检验。
//
// 【模型名以 qp2 清单为准】（2026-09-22 /v1/models 实测 27 个 + 连通探测）：
// kimicode-k3 / kimicode-k3-256k 与 ark-glm-5.2 已从网关目录【摘除】（别名仍通），
// 统一改成清单在册名 ark-kimi-k3 / ark-glm-5.3。评审档定档依据是
// 2026-09-22 的埋 bug 小测（findings-2026-09-22-real-verbs.md 同款探针）：
// deepseek-v4-pro / gpt-6-astra / ark-kimi-k3 都抓到核心缺陷，ark-glm-5.3
// 在 2500 tok 预算内零产出（留作 fallback 的一个信号）。
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
//   1.【Claude 模型做 agent 只能走原生通道】（历史约束，Claude 回来前无对象）。
//      网关代理的 Claude 只适合简单调用，不能跑 agent。test/profiles.mjs 仍守着
//      「经 pi 的 profile 里不许出现 claude 模型」。
//
//   2.【实现主力是 impl-glm 与 impl-deepseek】（GG 2026-09-23 定），
//      impl-deepseek-official 是 fallback——前两个都不可用时才派它。这条是【调度语义】，
//      活在 skill 里，profile 只在 description 里标明，引擎不认识「fallback」这个概念。
//      【这条改过四次】：082 GPT 下线提 Sonnet；2026-09-22 Claude 禁用、GPT 回归改
//      impl-kimi + impl-gpt；2026-09-23 GG 重排（Astra 专评 S+、v4 退役）改
//      impl-glm + impl-deepseek，fallback 换 DeepSeek 官方 API 通道。
//
// 分档（GG 2026-09-23 定，推翻 2026-09-22 的过渡排法）：
//   · Astra（gpt-6-astra）【只做评审】，是【唯一 S+】，思考强度【mid】——
//     全场唯一不拉 max 的模型。
//   · 评审 S 档：review-kimi（Kimi K3）、review-glm（GLM-5.3），均 max。
//   · 实现主力：impl-glm（GLM-5.3-flash）、impl-deepseek（DeepSeek V4.1 Flash，ark 通道），均 max。
//   · 实现 fallback：impl-deepseek-official——同一个 V4.1 Flash 但走 qp 里的
//     【DeepSeek 官方 API】通道（无前缀名）；ark 通道挂了才用它。
//   · 探索用 explore-astra（Astra 模型级就是 mid）。
//   · DeepSeek V4 / V4 Flash 全系【退役】（review-deepseek / explore-deepseek 移除）。
//
// `vendor` 是【谁家的模型】，不是谁家的通道：review-kimi 与 review-glm 都走 pi
// 却是两家；impl-deepseek 与 impl-deepseek-official 是同一模型的两条通道却是一家。
// 跨厂商评审看的是这个字段。
// 它是**事实标注**不是编排语义——引擎不认识「该配谁」，只是把厂商如实标出来，
// 让 skill 里那条「评审换一家」的规则有个能对照的东西，也让测试守得住。
// 模型名推不出来（sonnet 与 opus 都是 anthropic），所以只能显式写。
const BUILTIN = {
  // ---- 实现（思考等级 max）----
  "impl-glm": {
    harness: "pi",
    vendor: "zhipu",
    model: "quota-proxy/ark-glm-5.3-flash",
    effort: "max",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer — GLM-5.3 Flash (Zhipu) via pi. MAIN pair with impl-deepseek.",
  },
  "impl-deepseek": {
    harness: "pi",
    vendor: "deepseek",
    model: "quota-proxy/ark-deepseek-v4.1-flash",
    effort: "max",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer — DeepSeek V4.1 Flash via pi (ark channel). MAIN pair with impl-glm.",
  },
  "impl-deepseek-official": {
    harness: "pi",
    vendor: "deepseek",
    model: "quota-proxy/deepseek-v4.1-flash",
    effort: "max",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description:
      "Implementer — DeepSeek V4.1 Flash via pi (DeepSeek OFFICIAL API channel). " +
      "FALLBACK ONLY: dispatch this only when impl-glm and impl-deepseek are both unavailable.",
  },

  // ---- 评审（只读由引擎强制；Astra mid，其余 max）----
  "review-astra": {
    harness: "pi",
    vendor: "openai",
    model: "quota-proxy/gpt-6-astra",
    effort: "mid",
    prompt: REVIEWER_PROMPT,
    read_only: true,
    description:
      "Reviewer — GPT-6 Astra via pi. THE ONLY S+ seat (GG 2026-09-23); effort mid by design, " +
      "it does not need max to out-reason the field.",
  },
  "review-kimi": {
    harness: "pi",
    vendor: "moonshot",
    model: "quota-proxy/ark-kimi-k3",
    effort: "max",
    prompt: REVIEWER_PROMPT,
    read_only: true,
    description: "Reviewer — Kimi K3 via pi. S seat.",
  },
  "review-glm": {
    harness: "pi",
    vendor: "zhipu",
    model: "quota-proxy/ark-glm-5.3",
    effort: "max",
    prompt: REVIEWER_PROMPT,
    read_only: true,
    description: "Reviewer — GLM-5.3 (Zhipu) via pi. S seat.",
  },

  // ---- 评审（只读由各家引擎强制，见 lib/harness/*.mjs）----


  // ---- 探索 ----
  // 定位是【快 + 便宜】，用在大扇出粗筛上。Astra 模型级思考强度就是 mid（GG 2026-09-23），
  // 所以这一格是 mid 而不是「不拉等级」的旧默认。
  "explore-astra": {
    harness: "pi",
    vendor: "openai",
    model: "quota-proxy/gpt-6-astra",
    effort: "mid",
    prompt: EXPLORER_PROMPT,
    read_only: true,
    description: "Explorer — GPT-6 Astra via pi (effort mid). Fast wide fan-outs.",
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
// 默认值选 impl-glm，理由：
//   · 独立会话是让人往里派活的交互会话，需要 yolo + 完整 prompt + 拉满思考，
//     即一个实现档 profile——review-*/explore-* 全是 read_only，派了活也改不了代码。
//   · fallback（impl-deepseek-official）专用，不能做默认。
//   · 两个主力（impl-glm / impl-deepseek）里选通道历史上更稳的那个：
//     zhipu 的 ark 通道自 082 起一直在产；DeepSeek V4.1 Flash 是 2026-09-23 新上的档位。
// 【这条理由改过】：impl-gpt（原生 Codex 订阅）→ 082 GPT 下线改 impl-kimi →
// 2026-09-23 GG 重排档位（Astra 专评、实现 glm-flash + deepseek-flash）改 impl-glm。
export const DEFAULT_SESSION_START_PROFILE = "impl-glm";

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
