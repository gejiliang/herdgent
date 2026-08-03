// 跑一次「某个 harness × 某个 prompt」，返回可判分的原始记录。
//
// 【每次运行都是全新的 HOME】。不复用不是洁癖：harness 会在 HOME 里攒 session、
// 攒 todo、攒项目记忆，第 2 次跑就不再是干净起点，同一任务的多次重复就不可比了。
// 复制一份模板的成本是毫秒级，换来的是「n 次运行互相独立」这个前提成立。

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../adapters/index.mjs";

const BENCH_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WRAPPER = join(BENCH_DIR, "bin", "with-key.sh");
const HOMES = join(BENCH_DIR, "homes");
export const RUNS_DIR = join(BENCH_DIR, ".runs");

export async function runOne({
  harness,
  prompt,
  cwd,
  timeoutMs = 300_000,
  tag = "run",
  keepHome = false,
}) {
  const adapter = ADAPTERS[harness];
  if (!adapter) throw new Error(`unknown harness: ${harness}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(RUNS_DIR, `${stamp}-${harness}-${tag}`);
  const home = join(runDir, "home");
  await mkdir(runDir, { recursive: true });
  await cp(join(HOMES, harness), home, { recursive: true });

  const lastMessageFile = join(runDir, "last-message.txt");
  const args = adapter.args({ prompt, lastMessageFile, home });

  const env = {
    // 【白名单，不是继承】。继承当前进程的 env 会把 CLAUDE_CODE_* 一路带进受测会话
    // （herdgent 项目文档里记着这个坑：症状是 transcript 被关掉、会话标题串台）。
    PATH: process.env.PATH,
    TERM: "dumb",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    BENCH_HOME: home,
    ...adapter.env({ home }),
  };

  const started = Date.now();
  const res = await spawnCapture(WRAPPER, [adapter.bin, ...args], {
    cwd,
    env,
    timeoutMs,
  });
  const ms = Date.now() - started;

  let lastMessage = null;
  if (existsSync(lastMessageFile)) {
    lastMessage = await readFile(lastMessageFile, "utf8").catch(() => null);
  }

  // 【原始输出必须落盘】。解析规则会随 harness 升级而改，输出格式变了就得重解析 ——
  // 如果只留解析后的结果，每次改解析器都要重跑一遍全部实验，那是几十次真实调用的钱。
  await writeFile(join(runDir, "stdout.txt"), res.stdout);
  await writeFile(join(runDir, "stderr.txt"), res.stderr);

  let parsed = { text: "", usage: null };
  try {
    parsed = adapter.extract(res.stdout, { lastMessage });
  } catch (e) {
    parsed = { text: res.stdout.trim(), usage: null, parseError: String(e) };
  }

  if (!keepHome) await rm(home, { recursive: true, force: true });

  return {
    harness,
    wire: adapter.wire,
    tag,
    ok: res.code === 0 && !res.timedOut,
    exitCode: res.code,
    timedOut: res.timedOut,
    ms,
    runDir,
    stdout: res.stdout,
    stderr: res.stderr,
    ...parsed,
  };
}

function spawnCapture(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // 先 SIGTERM 给 harness 一个收尾机会，5s 后再 SIGKILL。
      // 直接 KILL 会让「卡死恢复型」任务分不清「它自己卡住」和「我们砍early了」。
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${e}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
