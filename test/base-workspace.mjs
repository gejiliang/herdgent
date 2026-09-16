#!/usr/bin/env node
// issue #13 假 herdr 层：startManagedSession（standalone 路径）的基础 workspace 跟踪。
//   · 正常路径：base 显式创建并登记归属证据；reclaimSession 时未被使用 → 一并关掉
//   · 启动失败：本次创建的 base 当场收回（不留壳）
//   · 启动失败 + 预存在的 base：领养的不动，只收自己的 worktree 容器
//
// 隔离是结构性的：HERDR_BIN_PATH 是假 CLI，HERDR_SOCKET_PATH 指向不存在的
// socket——这个进程【根本连不上】真 herdr（AGENTS.md 铁律）。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFakeHerdr, writePiTranscript } from "./fake-herdr.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-base-ws-"));
const state = join(home, "state");
const config = join(home, "config");
mkdirSync(state, { recursive: true });
mkdirSync(config, { recursive: true });
const fake = setupFakeHerdr(home, { hostWorkspace: false });
const transcript = join(home, "transcript.jsonl");
writePiTranscript(transcript, ["hello"]);

process.env.HERDGENT_HOME = home;
process.env.HERDGENT_STATE_DIR = state;
process.env.HERDGENT_CONFIG_DIR = config;
process.env.HERDR_BIN_PATH = fake.bin;
process.env.HERDR_SOCKET_PATH = join(home, "no-such-herdr.sock");
process.env.HG_FAKE_HERDR_STATE = fake.statePath;
process.env.HG_FAKE_TRANSCRIPT = transcript;

const repo = join(home, "repo");
mkdirSync(repo);
const repo2 = join(home, "repo2");
mkdirSync(repo2);

const worker = await import(`../lib/worker.mjs?t=${Date.now()}`);
const registry = await import(`../lib/registry.mjs?t=${Date.now()}`);
const fakeState = () => JSON.parse(readFileSync(fake.statePath, "utf8"));

try {
  // ---- 正常路径：显式创建 base 并登记；reclaim 时未被使用 → 一并收掉 ----
  const entry = worker.startManagedSession({
    cwd: repo,
    task: "做一件独立的小事",
    harness: "pi",
    title: "独立任务",
    branch: "feat/standalone",
  });
  check("standalone 起来了", entry.status === "active", entry.status);
  check(
    "登记了本次创建的 base 与归属证据",
    entry.base_workspace?.created_by_run === true && !!entry.base_workspace.workspace_id && !!entry.base_workspace.evidence,
    JSON.stringify(entry.base_workspace),
  );
  const baseId = entry.base_workspace.workspace_id;
  check(
    "假 herdr 里 base 与 worktree 容器都在",
    !!fakeState().workspaces[baseId] && !!fakeState().workspaces[entry.workspace_id],
    Object.keys(fakeState().workspaces).join(","),
  );
  check(
    "worktree create 用了显式 --workspace source",
    fakeState().calls.some((c) => c.startsWith(`worktree create --workspace ${baseId} `)),
    fakeState().calls.filter((c) => c.startsWith("worktree create")).join(" | "),
  );

  const steps = worker.reclaimSession(entry, { deleteBranch: false });
  check("reclaim 收了 worktree 容器", steps.includes("worktree_removed"), steps.join(","));
  check("reclaim 把未被使用的 base 也收了", steps.includes("base_workspace_closed"), steps.join(","));
  check(
    "base 与容器真没了",
    !fakeState().workspaces[baseId] && !fakeState().workspaces[entry.workspace_id],
    Object.keys(fakeState().workspaces).join(","),
  );

  // ---- 启动失败：本次创建的 base 当场收回，不留壳（startup 失败不误清也不漏清）----
  process.env.HG_FAKE_FAIL_AGENT_START = "1";
  let err1 = null;
  try {
    worker.startManagedSession({ cwd: repo, task: "必定起不来的任务", harness: "pi", title: "失败任务一", branch: "feat/fail1" });
  } catch (e) {
    err1 = e;
  }
  check("启动失败抛错", !!err1, err1?.message?.slice(0, 80));
  check(
    "失败回收包含 base 关闭结果",
    /reclaimed/.test(err1?.message ?? "") && /base w\d+ closed/.test(err1?.message ?? ""),
    err1?.message,
  );
  check(
    "本次创建的 base 与 worktree 容器都没留下",
    Object.keys(fakeState().workspaces).length === 0,
    Object.keys(fakeState().workspaces).join(","),
  );
  const failedRow = registry.list().find((s) => s.status === "failed");
  check("失败也落台账", !!failedRow && !!failedRow.base_workspace?.workspace_id, failedRow?.failure);

  // ---- 启动失败 + 预存在的 base：领养的一个指头都不碰 ----
  {
    const s = fakeState();
    s.workspaces.wPre = { workspace_id: "wPre", label: "repo2", cwd: repo2, kind: "plain", agent_status: "unknown" };
    s.tabs["wPre:t1"] = { tab_id: "wPre:t1", workspace_id: "wPre", label: "1" };
    s.panes["wPre:p1"] = { pane_id: "wPre:p1", tab_id: "wPre:t1", workspace_id: "wPre", foreground_cwd: repo2, agent_status: "unknown" };
    s.primaries[repo2] = "wPre";
    writeFileSync(fake.statePath, JSON.stringify(s, null, 2));
  }
  let err2 = null;
  try {
    worker.startManagedSession({ cwd: repo2, task: "又一个起不来的", harness: "pi", title: "失败任务二", branch: "feat/fail2" });
  } catch (e) {
    err2 = e;
  }
  check("预存在 base 下启动照样失败", !!err2, err2?.message?.slice(0, 80));
  const failedRow2 = registry.list().filter((s) => s.status === "failed").at(-1);
  check("台账记下领养关系", failedRow2?.base_workspace?.created_by_run === false && failedRow2.base_workspace.workspace_id === "wPre");
  check(
    "预存在的 wPre 原样保留（连 tab/pane 都在）",
    !!fakeState().workspaces.wPre && !!fakeState().tabs["wPre:t1"] && !!fakeState().panes["wPre:p1"],
    Object.keys(fakeState().workspaces).join(","),
  );
  check(
    "自己的 worktree 容器收掉了",
    !Object.values(fakeState().workspaces).some((w) => w.kind === "worktree"),
    Object.keys(fakeState().workspaces).join(","),
  );
  check("失败消息不误报 base 已收", !/base wPre closed/.test(err2?.message ?? ""), err2?.message);
} finally {
  delete process.env.HG_FAKE_FAIL_AGENT_START;
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
