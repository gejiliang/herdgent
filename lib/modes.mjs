// 编排模式：一次编排是哪种风格，决定容器形态和该读哪份 playbook。
//
//   rex —— 开发。要写代码，所以开 worktree、独立分支，改动不碰主工作区。
//   fox —— 研究。只读，所以不开 worktree，就在当前 space 加 tab。
//
// 两个名字都是犬科，跟 herdr 的牧群语义连着；三个字母，打起来快。
// 用户可以在 ~/.herdgent/config/modes.json 覆盖或新增自己的模式。
//
// mode 不是第三个要记的概念——它就是「rex 还是 fox」这一个选择，
// container 由它推导，调用方不用再单独声明一遍。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configRoot, workflowsRoot } from "./paths.mjs";

const BUILTIN = {
  rex: {
    container: "worktree",
    label: "rex",
    description:
      "开发编排：在自己的 worktree 和分支里实现，然后交给别家厂商评审。任何会写代码的活都走这个。",
    skill: "rex",
  },
  fox: {
    container: "tab",
    label: "fox",
    description:
      "研究编排：并行探索、只读，不开 worktree，就在当前 space 加 tab。调研、审查、找问题走这个。",
    skill: "fox",
  },
};

function userModes() {
  try {
    const raw = JSON.parse(readFileSync(join(configRoot(), "modes.json"), "utf8"));
    return raw && typeof raw === "object" ? raw.modes ?? raw : {};
  } catch {
    return {};
  }
}

export function allModes() {
  const merged = {};
  for (const [name, m] of Object.entries(BUILTIN)) merged[name] = { ...m, source: "builtin" };
  for (const [name, m] of Object.entries(userModes())) {
    merged[name] = { ...(merged[name] ?? {}), ...m, source: merged[name] ? "user-override" : "user" };
  }
  return merged;
}

export function getMode(name) {
  const m = allModes()[name];
  if (!m) {
    throw Object.assign(
      new Error(`unknown mode '${name}' (available: ${Object.keys(allModes()).join(", ")})`),
      { code: "unknown_mode" },
    );
  }
  return m;
}

// 找这个模式的 playbook。内置的在 skills/<name>/SKILL.md；
// 用户自定义的模式可以直接复用 config/workflows/<name>.md，
// 不用再学一个新目录。
export function skillPathFor(mode, name) {
  const key = mode.skill || name;
  const candidates = [
    join(workflowsRoot(), `${key}.md`), // 用户的优先——同名即覆盖内置
    join(import.meta.dirname, "..", "skills", key, "SKILL.md"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}
