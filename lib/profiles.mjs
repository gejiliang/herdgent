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

// 内置预设。模型名【必须带 provider 前缀】：pi 的 --model 不带前缀时会做模糊匹配，
// 可能匹配到另一个 provider 的同名模型然后报 "No API key found for ..."。
// 实测踩过——gpt-5.6-sol 被匹配到 azure-openai-responses，任务静默不执行；
// 而 gemini-3.5-flash-low 恰好只有一家有，所以同一个 bug 只在部分模型上显形。
// list_profiles 会跟 pi 的真实清单交叉核对并标出失效项。
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
  "claude-impl": {
    harness: "claude",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer on Claude Code. Writes code; give it a branch.",
  },
  "kimi-impl": {
    harness: "pi",
    model: "quota-proxy/kimicode-k3",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer on Kimi K3 (via pi). Cheaper second implementer for parallel work.",
  },
  "codex-impl": {
    harness: "codex",
    yolo: true,
    wants_branch: true,
    prompt: IMPLEMENTER_PROMPT,
    description: "Implementer on Codex. Writes code; give it a branch.",
  },
  "review-gpt": {
    harness: "pi",
    prompt: REVIEWER_PROMPT,
    model: "quota-proxy/gpt-5.6-sol",
    read_only: true,
    description: "Read-only reviewer on an OpenAI model.",
  },
  "review-gemini": {
    harness: "pi",
    prompt: REVIEWER_PROMPT,
    model: "quota-proxy/gemini-3.1-pro-low",
    read_only: true,
    description: "Read-only reviewer on a Google model.",
  },
  "review-kimi": {
    harness: "pi",
    prompt: REVIEWER_PROMPT,
    model: "quota-proxy/kimicode-k3",
    read_only: true,
    description: "Read-only reviewer on a Moonshot model.",
  },
  "review-deepseek": {
    harness: "pi",
    prompt: REVIEWER_PROMPT,
    model: "quota-proxy/bailian-deepseek-v4-pro",
    read_only: true,
    description: "Read-only reviewer on a DeepSeek model.",
  },
  "review-claude": {
    harness: "pi",
    prompt: REVIEWER_PROMPT,
    model: "quota-proxy/claude-opus-4-8",
    read_only: true,
    description: "Read-only reviewer on an Anthropic model (via pi, so it stays read-only).",
  },
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

// profile 给默认值，显式参数【永远】覆盖它——编排者临时改一处不该被迫另建 profile。
export function applyProfile(args) {
  if (!args.profile) return { ...args, profile_applied: null };
  const p = getProfile(args.profile);
  return {
    ...args,
    harness: args.harness ?? p.harness,
    model: args.model ?? p.model ?? null,
    yolo: args.yolo ?? p.yolo ?? false,
    read_only: args.read_only ?? p.read_only ?? false,
    prompt: args.prompt ?? p.prompt ?? null,
    profile_applied: args.profile,
    profile_wants_branch: !!p.wants_branch,
  };
}
