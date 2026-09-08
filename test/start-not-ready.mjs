#!/usr/bin/env node
// startAgentWhenReady 对 agent start 各种回答的处理。不碰 herdr——假 herdr 按剧本回答。
//
// 守的是 herdr 0.9.0 的契约（docs/findings-2026-09-08.md）：
//   · agent_not_ready = agent 已在跑但启动期就 blocked（opening prompt 立刻弹框 / 目录信任框）。
//     要当成「起来了、在等人」返回，带 blocked_at_startup，【不重试】——它不会自己变 idle。
//     此时 agent_session 可能还没有（信任框没过），不能拿它当门槛。
//   · agent_pane_busy 仍然重试到超时。
//   · 其它错误：pane 上真有带 session 的目标 agent 就接过来，否则上抛。
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-startnotready-"));
process.env.HERDR_SOCKET_PATH = join(home, "no-such-herdr.sock");

const stateFile = join(home, "fake-state.json");
const fakeHerdr = join(home, "fake-herdr.mjs");
writeFileSync(
  fakeHerdr,
  `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const stateFile = process.env.HG_FAKE_STATE;
const st = JSON.parse(readFileSync(stateFile, "utf8"));
function ok(result) { process.stdout.write(JSON.stringify({ id: "fake", result }) + "\\n"); process.exit(0); }
function fail(code) { process.stderr.write(JSON.stringify({ id: "fake", error: { code, message: "fake herdr error" } }) + "\\n"); process.exit(1); }
const [a, b] = args;
if (a === "agent" && b === "start") {
  st.starts = (st.starts || 0) + 1;
  writeFileSync(stateFile, JSON.stringify(st));
  if (st.start_error) fail(st.start_error);
  ok({ agent: { agent: "claude", pane_id: "w1:p1", agent_status: "idle", state_change_seq: 1 }, type: "agent_started" });
}
if (a === "agent" && b === "get") {
  if (st.get_fails) fail("agent_not_found");
  const agent = { agent: st.kind || "claude", pane_id: "w1:p1", agent_status: st.status || "idle", state_change_seq: 3 };
  if (st.session) agent.agent_session = { agent: agent.agent, kind: "id", value: st.session };
  ok({ agent, type: "agent_info" });
}
fail("unexpected_call");
`,
);
chmodSync(fakeHerdr, 0o755);
process.env.HERDR_BIN_PATH = fakeHerdr;
process.env.HG_FAKE_STATE = stateFile;

const { startAgentWhenReady } = await import(`../lib/herdr.mjs?t=${Date.now()}`);

const ARGS = ["agent", "start", "w", "--kind", "claude", "--pane", "w1:p1", "--", "claude", "hi"];
function run(state, opts = {}) {
  writeFileSync(stateFile, JSON.stringify(state));
  let result = null;
  let error = null;
  try {
    result = startAgentWhenReady(ARGS, { timeoutMs: 300, intervalMs: 20, ...opts });
  } catch (e) {
    error = e;
  }
  const starts = JSON.parse(readFileSync(stateFile, "utf8")).starts || 0;
  return { result, error, starts };
}

// ---- agent_not_ready：启动期 blocked，session 还没有 ----
{
  const { result, error, starts } = run({ start_error: "agent_not_ready", status: "blocked" });
  check("agent_not_ready 不当失败", !error && !!result, error ? `${error.code}: ${error.message}` : "");
  check("带 blocked_at_startup 标记", result?.blocked_at_startup === true && result?.recovered === true, JSON.stringify(result));
  check("返回的 agent 是 blocked 的那条", result?.agent?.agent_status === "blocked", JSON.stringify(result?.agent));
  check("不重试 agent start", starts === 1, `starts=${starts}`);
}

// ---- agent_not_ready 但 pane 上是别家 agent：不冒领 ----
{
  const { error, starts } = run({ start_error: "agent_not_ready", status: "blocked", kind: "codex" });
  check("kind 不符时照旧上抛 agent_not_ready", error?.code === "agent_not_ready", String(error?.code));
  check("上抛前也不重试", starts === 1, `starts=${starts}`);
}

// ---- agent_not_ready 但 get 说 idle 且无 session：说不通，上抛 ----
{
  const { error } = run({ start_error: "agent_not_ready", status: "idle" });
  check("not_ready 与 idle 无 session 矛盾时上抛", error?.code === "agent_not_ready", String(error?.code));
}

// ---- agent_pane_busy：重试到超时 ----
{
  const { error, starts } = run({ start_error: "agent_pane_busy", get_fails: true });
  check("pane_busy 重试后仍失败则上抛 agent_pane_busy", error?.code === "agent_pane_busy", String(error?.code));
  check("pane_busy 确实重试过", starts > 1, `starts=${starts}`);
}

// ---- 其它错误但 agent 已带 session 起来：接过来 ----
{
  const { result, error, starts } = run({ start_error: "agent_start_timeout", status: "idle", session: "abc" });
  check("超时但 agent 已起来则接管", !error && result?.recovered === true && !result?.blocked_at_startup, JSON.stringify(result));
  check("接管不重试", starts === 1, `starts=${starts}`);
}

// ---- 其它错误且 pane 上没有带 session 的 agent：上抛 ----
{
  const { error } = run({ start_error: "agent_start_timeout", status: "idle" });
  check("超时且无 session 则上抛", error?.code === "agent_start_timeout", String(error?.code));
}

// ---- 正常成功：原样返回 ----
{
  const { result, error, starts } = run({});
  check("成功时原样返回 agent", !error && result?.agent?.agent === "claude" && !result?.recovered, JSON.stringify(result));
  check("成功只调一次", starts === 1, `starts=${starts}`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall passed");
