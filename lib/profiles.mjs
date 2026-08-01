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
//   codex  → ChatGPT 订阅，跑 OpenAI 自家模型
//   pi     → quota-proxy 网关，承载其余所有厂商
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

const BUILTIN = {
  // ---- 实现 ----
  "codex-impl": {
    harness: "codex",
    model: "gpt-5.6-terra",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer on Codex / GPT-5.6 Terra. One of the two workhorses.",
  },
  "kimi-impl": {
    harness: "pi",
    model: "quota-proxy/kimicode-k3-256k",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer on Kimi K3 256K (via pi). One of the two workhorses.",
  },
  "claude-impl": {
    harness: "claude",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer on Claude Code, session default model.",
  },

  // ---- 评审（只读，各家用自己最硬的机制，见 lib/harness/*.mjs）----
  "review-gpt": {
    harness: "codex",
    prompt: REVIEWER_PROMPT,
    read_only: true,
    description: "Read-only reviewer on Codex, session default model (sandboxed read-only).",
  },
  "review-claude": {
    harness: "claude",
    prompt: REVIEWER_PROMPT,
    read_only: true,
    description: "Read-only reviewer on Claude Code. Cannot run commands — feed it the diff.",
  },
  "review-kimi": {
    harness: "pi",
    prompt: REVIEWER_PROMPT,
    model: "quota-proxy/kimicode-k3-256k",
    read_only: true,
    description: "Read-only reviewer on a Moonshot model.",
  },
  "review-gemini": {
    harness: "pi",
    prompt: REVIEWER_PROMPT,
    model: "quota-proxy/gemini-3.1-pro-low",
    read_only: true,
    description: "Read-only reviewer on a Google model.",
  },
  "review-deepseek": {
    harness: "pi",
    prompt: REVIEWER_PROMPT,
    model: "quota-proxy/bailian-deepseek-v4-pro",
    read_only: true,
    description: "Read-only reviewer on a DeepSeek model.",
  },

  // ---- 探索 ----
  "explore-fast": {
    harness: "pi",
    prompt: EXPLORER_PROMPT,
    model: "quota-proxy/gemini-3.5-flash-low",
    read_only: true,
    description: "Cheap fast read-only explorer for wide fan-outs.",
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
    yolo: p.yolo ?? false,
    read_only: p.read_only ?? false,
    prompt: p.prompt ?? null,
    profile_applied: args.profile,
    profile_wants_branch: !!p.wants_branch,
  };
}
