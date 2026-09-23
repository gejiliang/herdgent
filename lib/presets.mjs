// 编排预设：把「一次编排怎么组织」写成数据。
//
// profile 管「一个 worker 怎么起」，preset 管「几个 worker 按什么顺序、
// 谁的产物喂给谁、跑在什么容器里」。两层都是【配置不是代码】。
//
// 容器是模板的一部分，不是调用方每次现想的：写代码的编排必须开 worktree
// （不然并行的 worker 互相踩），只读研究开 worktree 纯属浪费（还要收尾删分支）。
//
// 执行引擎（bin/mcp-server.mjs 的 run_preset）刻意保持哑：它只认识四个动作——
// 派活、等完成、取产物、把产物塞进下一步的任务里。它不知道「评审」是什么意思，
// 也不知道为什么 reviewer 要换一家厂商。那些语义全在预设数据里。
//
// 这是 AGENTS.md 那条编排层边界的落法：语义从 prompt 挪进了结构化配置，
// 但仍然没进代码——引擎换个预设就干完全不同的事，它自己什么都不懂。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configRoot } from "./paths.mjs";

const BUILTIN = {
  "impl-and-review": {
    mode: "rex", // 开发编排：独立 worktree 和分支
    description:
      "在自己的 worktree 里实现一个改动，然后把 diff 交给【另一家厂商】的只读评审。最常用的一个。",
    inputs: {
      task: "要实现什么（写清楚验收标准，实现者和评审者都会看到）",
      label: "这次编排的名字，会成为 workspace 标签",
    },
    // branch 是【容器级】的：一次编排一个 worktree、一个分支，
    // 所有 worker 在同一个 checkout 里干活。不再是每步一个分支。
    steps: [
      {
        id: "impl",
        profile: "impl-kimi",
        title: "impl",
        task: "{{task}} 完成后 git add 并 commit。",
      },
      {
        id: "review",
        profile: "review-deepseek",
        title: "review",
        attach: "diff_of:impl",
        task:
          "审查一个改动，只报告问题，不要修改任何文件。改动的完整 diff 在 {{attached}}。" +
          "对照下面的要求逐条核对，明确给出 PASS 或 FAIL 以及理由：{{task}}",
      },
    ],
  },

  "fanout-review": {
    mode: "fox", // 研究编排：只读，不开 worktree
    description:
      "把当前工作区的改动同时交给三家不同厂商只读评审，只采信多数意见。不实现任何东西。",
    inputs: {
      diff_ref: "要审的范围，git diff 的参数，例如 main..feature 或 HEAD~1",
      task: "验收标准 / 关注点",
    },
 
    // 一个步骤、三个 profile —— 这才是并行。写成三个步骤是串行，等三倍的时间
    // 拿一样的结果。
    steps: [
      {
        id: "review",
        title: "review",
        profile: ["review-gpt", "review-kimi", "review-deepseek"],
        attach: "diff_of:{{diff_ref}}",
        task: "只读评审，不改任何文件。diff 在 {{attached}}。关注点：{{task}}",
      },
    ],
  },
};

function userPresets() {
  try {
    const raw = JSON.parse(readFileSync(join(configRoot(), "presets.json"), "utf8"));
    return raw && typeof raw === "object" ? raw.presets ?? raw : {};
  } catch {
    return {}; // 没配置不是错误
  }
}

export function allPresets() {
  const merged = {};
  for (const [name, p] of Object.entries(BUILTIN)) merged[name] = { ...p, source: "builtin" };
  for (const [name, p] of Object.entries(userPresets())) {
    merged[name] = { ...(merged[name] ?? {}), ...p, source: merged[name] ? "user-override" : "user" };
  }
  return merged;
}

export function getPreset(name) {
  const p = allPresets()[name];
  if (!p) {
    throw Object.assign(
      new Error(`unknown preset '${name}' (available: ${Object.keys(allPresets()).join(", ")})`),
      { code: "unknown_preset" },
    );
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    throw Object.assign(new Error(`preset '${name}' has no steps`), { code: "bad_preset" });
  }
  return p;
}

// 模板只做字符串替换，不求值、不执行。变量来自用户给的 inputs 和上游产物。
// 缺失的变量原样留着而不是替成空——静默变空会让任务描述看起来完整但实际缺内容。
export function render(template, vars) {
  return String(template ?? "").replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}

// 缺哪个必填输入。引擎在派出第一个 worker【之前】检查——
// 跑到一半才发现缺参数，前面已经烧掉的额度就回不来了。
export function missingInputs(preset, provided) {
  const need = Object.keys(preset.inputs ?? {});
  return need.filter((k) => !provided[k] || !String(provided[k]).trim());
}
