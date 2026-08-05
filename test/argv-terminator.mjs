#!/usr/bin/env node
// harness 的位置参数边界。只拼数组，不起 agent / 不碰 herdr。
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// 第二层保险：这条测试今天不调 herdr，将来若有人把它扩成启动路径也必须连不上。
const home = join(tmpdir(), "hg-argv-terminator-nonexistent");
process.env.HERDGENT_HOME = home;
process.env.HERDR_SOCKET_PATH = join(home, "no-such-herdr.sock");

const { buildHarnessCommandArgs } = await import(`../lib/worker.mjs?t=${Date.now()}`);
const { getHarness } = await import(`../lib/harness/index.mjs?t=${Date.now()}`);

const OPENING_PROMPT = "回答两个字：收到";
const options = {
  cwd: "/tmp/repo",
  settingsPath: "/tmp/settings.json",
  model: "test-model",
  effort: "high",
  yolo: true,
  prompt: "system prompt",
  sessionDir: "/tmp/harness-sessions",
};

function compose(kind, readOnly) {
  const adapter = getHarness(kind);
  const flags = adapter.buildArgs({ ...options, readOnly });
  return { flags, argv: buildHarnessCommandArgs(adapter, flags, OPENING_PROMPT) };
}

// `--allowed-tools` / `--disallowed-tools` 是变参，所以 prompt 必须在 adapter
// 给出的 terminator 之后；这里不执行 Claude，只锁住这个 argv 契约。
{
  const { argv } = compose("claude", true);
  const terminator = argv.lastIndexOf("--");
  check("只读 Claude 有工具限制", argv.includes("--allowed-tools") && argv.includes("--disallowed-tools"));
  check(
    "只读 Claude 的 opening prompt 在 -- 后",
    terminator === argv.length - 2 && argv.at(-1) === OPENING_PROMPT,
    argv.join(" "),
  );
}

// 即使当前没有变参 flag，Claude 也始终声明边界；以后 profile 改成只读才不会重演吞 prompt。
{
  const { argv } = compose("claude", false);
  const terminator = argv.lastIndexOf("--");
  check(
    "非只读 Claude 的 opening prompt 同样在 -- 后",
    terminator === argv.length - 2 && argv.at(-1) === OPENING_PROMPT,
    argv.join(" "),
  );
}

for (const kind of ["codex", "pi"]) {
  const { flags, argv } = compose(kind, true);
  check(
    `${kind} 没有变参 flag，argv 不被改写`,
    !argv.includes("--") && JSON.stringify(argv) === JSON.stringify([...flags, OPENING_PROMPT]),
    argv.join(" "),
  );
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
