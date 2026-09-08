#!/usr/bin/env node
// sendAndConfirm 的投递路径。不碰 herdr——用假 herdr 记下它到底发了哪些命令。
//
// 守的是 herdr 0.9.0 的契约（docs/findings-2026-09-08.md）：
//   · 正常提交只发一次 agent prompt，【不再】补 send-keys enter——多补的 Enter 会替人按下审批框默认项
//   · agent 已 blocked 时不碰 agent prompt（herdr 会拒收 agent_blocked），改走 pane send-text + enter
//   · get 与 prompt 之间刚好卡住（prompt 报 agent_blocked）时同样落到 send-text 路径
//   · keys 给了就只发 send-keys；text 与 keys 都没有则拒绝
//   · 提交与否只信 state_change_seq 的变化
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-sendconfirm-"));
mkdirSync(join(home, "state"), { recursive: true });
process.env.HERDGENT_HOME = home;
process.env.HERDGENT_STATE_DIR = join(home, "state");
// 结构性隔离：这个进程必须根本连不上真 herdr。
process.env.HERDR_SOCKET_PATH = join(home, "no-such-herdr.sock");

const stateFile = join(home, "fake-state.json");
const logFile = join(home, "fake-calls.log");
const fakeHerdr = join(home, "fake-herdr.mjs");
writeFileSync(
  fakeHerdr,
  `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const stateFile = process.env.HG_FAKE_STATE;
const st = JSON.parse(readFileSync(stateFile, "utf8"));
appendFileSync(process.env.HG_FAKE_LOG, args.join(" ") + "\\n");
function ok(result) { process.stdout.write(JSON.stringify({ id: "fake", result }) + "\\n"); process.exit(0); }
function fail(code) { process.stderr.write(JSON.stringify({ id: "fake", error: { code, message: "fake herdr error" } }) + "\\n"); process.exit(1); }
function bump() { if (!st.mute) { st.seq += 1; st.status = "working"; } writeFileSync(stateFile, JSON.stringify(st)); }
const [a, b] = args;
if (a === "agent" && b === "get") ok({ agent: { agent: "claude", pane_id: "w1:p1", agent_status: st.status, state_change_seq: st.seq } });
if (a === "agent" && b === "prompt") {
  if (st.status === "blocked" || st.prompt_fails) fail("agent_blocked");
  bump(); ok({ type: "agent_prompted" });
}
// 真 herdr 的 pane send-text 成功时【什么都不打】（0.9.0 实测）——按真实行为来，守住 herdrText 那条路。
if (a === "pane" && b === "send-text") process.exit(0);
if (a === "agent" && b === "send-keys") { bump(); ok({ type: "ok" }); }
fail("unexpected_call");
`,
);
chmodSync(fakeHerdr, 0o755);
process.env.HERDR_BIN_PATH = fakeHerdr;
process.env.HG_FAKE_STATE = stateFile;
process.env.HG_FAKE_LOG = logFile;

const { sendAndConfirm } = await import(`../lib/worker.mjs?t=${Date.now()}`);

function run(state, text, opts = {}) {
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(logFile, "");
  const r = sendAndConfirm("w1:p1", text, { timeoutMs: 2000, intervalMs: 20, ...opts });
  const calls = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  return { r, calls };
}
const count = (calls, prefix) => calls.filter((c) => c.startsWith(prefix)).length;

// ---- idle：一次 prompt，没有补回车 ----
{
  const { r, calls } = run({ status: "idle", seq: 5 }, "继续");
  check("idle 时只发一次 agent prompt", count(calls, "agent prompt w1:p1 继续") === 1, calls.join(" | "));
  check("idle 时不再补 send-keys enter", count(calls, "agent send-keys") === 0, calls.join(" | "));
  check("idle 时不走 pane send-text", count(calls, "pane send-text") === 0);
  check("delivery=prompt 且 submitted", r.delivery === "prompt" && r.submitted === true, JSON.stringify(r));
  check("seq 变化被记下", r.seq_before === 5 && r.seq_after === 6, JSON.stringify(r));
}

// ---- blocked：不碰 prompt，走 send-text + enter ----
{
  const { r, calls } = run({ status: "blocked", seq: 5 }, "yes");
  check("blocked 时不调用 agent prompt", count(calls, "agent prompt") === 0, calls.join(" | "));
  check("blocked 时经 pane send-text 打字", count(calls, "pane send-text w1:p1 yes") === 1, calls.join(" | "));
  check("blocked 时随后补 enter", count(calls, "agent send-keys w1:p1 enter") === 1, calls.join(" | "));
  check("delivery=send_text 且 submitted", r.delivery === "send_text" && r.submitted === true, JSON.stringify(r));
}

// ---- 竞态：get 看到 idle，prompt 却被拒 agent_blocked ----
{
  const { r, calls } = run({ status: "idle", seq: 5, prompt_fails: true }, "yes");
  check("先尝试了 agent prompt", count(calls, "agent prompt") === 1, calls.join(" | "));
  check("被拒后落到 send-text 路径", count(calls, "pane send-text") === 1 && count(calls, "agent send-keys w1:p1 enter") === 1, calls.join(" | "));
  check("竞态下 delivery=send_text 且 submitted", r.delivery === "send_text" && r.submitted === true, JSON.stringify(r));
}

// ---- keys：只发 send-keys ----
{
  const { r, calls } = run({ status: "blocked", seq: 5 }, null, { keys: ["down", "enter"] });
  check("keys 原样经 agent send-keys 发出", count(calls, "agent send-keys w1:p1 down enter") === 1, calls.join(" | "));
  check("keys 时不发 prompt 也不打字", count(calls, "agent prompt") === 0 && count(calls, "pane send-text") === 0);
  check("delivery=keys 且 submitted", r.delivery === "keys" && r.submitted === true, JSON.stringify(r));
}

// ---- 没观察到状态变化：如实报 submitted=false ----
{
  const { r } = run({ status: "idle", seq: 5, mute: true }, "继续", { timeoutMs: 120 });
  check("seq 不变则 submitted=false", r.submitted === false && r.seq_after === 5, JSON.stringify(r));
}

// ---- text 与 keys 都没有：拒绝，且不碰 herdr ----
{
  writeFileSync(stateFile, JSON.stringify({ status: "idle", seq: 5 }));
  writeFileSync(logFile, "");
  let code = null;
  try {
    sendAndConfirm("w1:p1", "", { keys: [] });
  } catch (e) {
    code = e.code;
  }
  check("空输入被拒 text_or_keys_required", code === "text_or_keys_required", String(code));
  check("拒绝前没有发任何命令", readFileSync(logFile, "utf8").trim() === "");
}

// ---- 非法 harness 仍然报错（校验没被顺手删掉） ----
{
  let code = null;
  try {
    sendAndConfirm("w1:p1", "hi", { harness: "nope" });
  } catch (e) {
    code = e.code;
  }
  check("未知 harness 仍拒绝", code === "unsupported_harness", String(code));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall passed");
