// Harness 适配注册表。
//
// 每接一家都要【逐条实测】下面这些点，不能照抄上一家——claude 与 codex 在
// 提交语义（要不要补 enter）、目录信任、session id 来源、transcript 格式上
// 全都不一样，而且每一处不一样都会让编排静默失败而不是报错。
import claude from "./claude.mjs";
import codex from "./codex.mjs";

const REGISTRY = new Map([
  [claude.kind, claude],
  [codex.kind, codex],
]);

export const SUPPORTED = [...REGISTRY.keys()];

export function getHarness(kind) {
  const h = REGISTRY.get(kind);
  if (!h) {
    throw Object.assign(
      new Error(`unsupported harness '${kind}' (supported: ${SUPPORTED.join(", ")})`),
      { code: "unsupported_harness" },
    );
  }
  return h;
}
