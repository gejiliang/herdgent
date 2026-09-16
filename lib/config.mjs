import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configRoot } from "./paths.mjs";

// 验收通过后的默认动作是【收】（GG 定，2026-09-16，推翻了早先的 keep 默认）。
// 清理由 finalize_run 执行——它有核验（merge-base / 脏检查 / 归属扫描）兜底，
// 不再是「拿到就删」，所以默认收是安全的；keep 是显式的例外，留现场给人看。
// 缺文件 / 坏 JSON / 缺键 / 值非法一律回 auto，与「失败 / 未验收绝不清」不冲突：
// 这个值只在验收通过之后才被消费。
export const DEFAULT_CLEANUP_AFTER_ACCEPT = "auto";

export function cleanupAfterAccept() {
  try {
    const config = JSON.parse(readFileSync(join(configRoot(), "config.json"), "utf8"));
    return config?.cleanup_after_accept === "auto" || config?.cleanup_after_accept === "keep"
      ? config.cleanup_after_accept
      : DEFAULT_CLEANUP_AFTER_ACCEPT;
  } catch {
    return DEFAULT_CLEANUP_AFTER_ACCEPT;
  }
}
