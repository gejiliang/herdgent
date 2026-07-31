#!/usr/bin/env node
import * as registry from "../lib/registry.mjs";

const rows = registry.list();
if (rows.length === 0) {
  console.log("no managed sessions");
} else {
  for (const s of rows) {
    console.log([s.status.padEnd(8), (s.harness || "?").padEnd(7), s.key, s.workspace_label, s.cwd].join("  "));
  }
}
