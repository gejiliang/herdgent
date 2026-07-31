// Worker profile：把「用什么跑」收成一个名字。
//
// 没有它的话，编排者每次派活都要自己拼 harness / model / yolo / read_only 四个参数，
// 组错了还不会立刻报错（比如给只读评审忘了 read_only，它就真去改代码了）。
//
// profile 是【配置不是代码】：它描述用什么工具跑，不描述谁评审谁。
// 后者是编排语义，只能活在 skill 里（见 AGENTS.md 的编排层边界）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 内置预设。模型名写的是本机 quota-proxy 上实际存在的——list_profiles 会跟
// pi 的真实模型清单交叉核对并标出失效项，不会让编排者拿着一个跑不起来的名字去派活。
const BUILTIN = {
  "claude-impl": {
    harness: "claude",
    yolo: true,
    wants_branch: true,
    description: "Implementer on Claude Code. Writes code; give it a branch.",
  },
  "codex-impl": {
    harness: "codex",
    yolo: true,
    wants_branch: true,
    description: "Implementer on Codex. Writes code; give it a branch.",
  },
  "review-gpt": {
    harness: "pi",
    model: "gpt-5.6-sol",
    read_only: true,
    description: "Read-only reviewer on an OpenAI model.",
  },
  "review-gemini": {
    harness: "pi",
    model: "gemini-3.1-pro-low",
    read_only: true,
    description: "Read-only reviewer on a Google model.",
  },
  "review-kimi": {
    harness: "pi",
    model: "kimicode-k3",
    read_only: true,
    description: "Read-only reviewer on a Moonshot model.",
  },
  "review-deepseek": {
    harness: "pi",
    model: "bailian-deepseek-v4-pro",
    read_only: true,
    description: "Read-only reviewer on a DeepSeek model.",
  },
  "review-claude": {
    harness: "pi",
    model: "claude-opus-4-8",
    read_only: true,
    description: "Read-only reviewer on an Anthropic model (via pi, so it stays read-only).",
  },
  "explore-fast": {
    harness: "pi",
    model: "gemini-3.5-flash-low",
    read_only: true,
    description: "Cheap fast read-only explorer for wide fan-outs.",
  },
};

// 用户自定义放插件配置目录，键名相同即覆盖内置。
function userProfiles() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) return {};
  try {
    const raw = JSON.parse(readFileSync(join(dir, "profiles.json"), "utf8"));
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
    profile_applied: args.profile,
    profile_wants_branch: !!p.wants_branch,
  };
}
