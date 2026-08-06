import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configRoot } from "./paths.mjs";

export const DEFAULT_CLEANUP_AFTER_ACCEPT = "keep";

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
