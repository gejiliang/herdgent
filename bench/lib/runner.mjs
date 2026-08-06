// 跑一次「某个 harness × 某个 prompt」，返回可判分的原始记录。
//
// 【每次运行都是全新的 HOME】。不复用不是洁癖：harness 会在 HOME 里攒 session、
// 攒 todo、攒项目记忆，第 2 次跑就不再是干净起点，同一任务的多次重复就不可比了。
// 复制一份模板的成本是毫秒级，换来的是「n 次运行互相独立」这个前提成立。

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../adapters/index.mjs";
import { startMeter } from "./meter.mjs";

const BENCH_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WRAPPER = join(BENCH_DIR, "bin", "with-key.sh");
const HOMES = join(BENCH_DIR, "homes");
export const RUNS_DIR = join(BENCH_DIR, ".runs");

// 基础设施失败的特征串。【必须和「能力失败」分开】——
// 实测 opencode 跑到一半吃了个 `unknown certificate verification error`，
// 8 秒退出、零输出。不重试的话，这一次网络抖动就会被记成「它评审能力差」，
// 而它上一次在同一道题上是正常出结果的。
const INFRA_PATTERNS =
  /certificate|econnreset|etimedout|enotfound|eai_again|socket hang up|connection (error|closed|reset)|rate.?limit|429|50[234]|bad gateway|service unavailable|gateway time-?out/i;

export function looksLikeInfraFailure(res, parsedText) {
  // 只在【什么也没产出】时才认；有输出就说明它真跑了，那是能力问题不是网络问题
  if (parsedText && parsedText.trim()) return false;
  return INFRA_PATTERNS.test(res.stderr ?? "");
}

export async function runOne(opts) {
  const { retries = 2 } = opts;
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await runOnce({ ...opts, attempt });
    if (!last.infraFailure) break;
    if (attempt < retries) {
      // 退避：证书/限流类问题立刻重试多半还是撞同一堵墙
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
  return last;
}

async function runOnce({
  harness,
  prompt,
  cwd,
  timeoutMs = 300_000,
  tag = "run",
  keepHome = false,
  attempt = 0,
  meterEnabled = true,
}) {
  const adapter = ADAPTERS[harness];
  if (!adapter) throw new Error(`unknown harness: ${harness}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(RUNS_DIR, `${stamp}-${harness}-${tag}${attempt ? `-retry${attempt}` : ""}`);
  const home = join(runDir, "home");
  await mkdir(runDir, { recursive: true });
  await cp(join(HOMES, harness), home, { recursive: true });

  const lastMessageFile = join(runDir, "last-message.txt");
  const args = adapter.args({ prompt, lastMessageFile, home });

  // 本地计量代理：五家的请求全从这里过，才有可能用同一把尺子数 token。
  // 各家自报的口径根本对不上（两家不报，报的三家缓存算法各不相同），
  // 而网关的用量接口要 admin 凭证、且网关归 homelab 管，不能为评测去动。
  const meter = meterEnabled ? await startMeter({ logFile: join(runDir, "meter.jsonl"), label: `${harness}/${tag}` }) : null;

  const env = {
    // 【白名单，不是继承】。继承当前进程的 env 会把 CLAUDE_CODE_* 一路带进受测会话
    // （herdgent 项目文档里记着这个坑：症状是 transcript 被关掉、会话标题串台）。
    PATH: process.env.PATH,
    TERM: "dumb",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    BENCH_HOME: home,
    ...(meter ? { BENCH_BASE_URL: meter.baseUrl } : {}),
    ...adapter.env({ home }),
  };

  const started = Date.now();
  const res = await spawnCapture(WRAPPER, [adapter.bin, ...args], {
    cwd,
    env,
    timeoutMs,
    stdoutFile: join(runDir, "stdout.txt"),
    stderrFile: join(runDir, "stderr.txt"),
  });
  const ms = Date.now() - started;
  const tokens = meter ? { ...meter.totals } : null;
  if (meter) await meter.stop();

  let lastMessage = null;
  if (existsSync(lastMessageFile)) {
    lastMessage = await readFile(lastMessageFile, "utf8").catch(() => null);
  }

  // 原始输出已由 spawnCapture 流式写进 runDir —— 解析规则会随 harness 升级而改，
  // 只留解析后的结果的话，每次改解析器都得重跑全部实验，那是几十次真实调用的钱。

  let parsed = { text: "", usage: null };
  try {
    parsed = adapter.extract(res.stdout, { lastMessage });
  } catch (e) {
    parsed = { text: res.stdout.trim(), usage: null, parseError: String(e) };
  }

  if (!keepHome) await hardRemove(home);

  return {
    harness,
    wire: adapter.wire,
    tag,
    attempt,
    // 网络/网关问题导致的空跑。调用方据此重试，并且【不能当成能力分记进结果】。
    infraFailure: looksLikeInfraFailure(res, parsed.text),
    ok: res.code === 0 && !res.timedOut,
    exitCode: res.code,
    timedOut: res.timedOut,
    ms,
    // 【传输量 ≠ 内容量，两个都要记，且不能混为一谈】（栽过）：
    // pi 单次跑出 62MB stdout，我一度把它当成「这家输出啰嗦」写进结论。
    // 拆开一看 99.9% 是协议重复 —— 它的 --mode json 每次增量都重发【整条消息快照】
    // 而不是 delta，message_update 的大小随消息增长（开头 ~1KB、结尾 ~9.5KB），
    // 9219 次累积成 O(n²)。真实内容只有 90KB，和其它家同一量级。
    //
    // 所以：
    //   stdoutBytes   传输量 —— 【受输出模式影响，不是能力特征】
    //   answerBytes   最终答案的字节数 —— 五家都能算，可比
    //   amplification 传输量 / 答案量 —— 「为了拿到这段答案要处理多少字节」，
    //                 这才是编排方真正付的解析成本
    stdoutBytes: res.stdoutBytes,
    stdoutTruncated: res.stdoutTruncated,
    answerBytes: Buffer.byteLength(parsed.text ?? "", "utf8"),
    amplification: parsed.text
      ? res.stdoutBytes / Math.max(1, Buffer.byteLength(parsed.text, "utf8"))
      : null,
    // 【唯一可跨家比较的 token 数】，来自本地代理而非各家自报
    tokens,
    runDir,
    stdout: res.stdout,
    stderr: res.stderr,
    ...parsed,
  };
}

/**
 * 删除受测进程留下的目录树。
 *
 * 【不能只用 fs.rm】：受测 harness 会在假 HOME 里跑构建工具，而 Go module cache
 * （home/go/pkg/mod/…）是【只读】的，Node 的 rm 直接 EACCES 崩掉，
 * 整个批次就死在清理这一步。先把写权限加回来再删。
 */
async function hardRemove(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
    return;
  } catch {
    /* 多半是只读的依赖缓存，下面强来 */
  }
  await new Promise((resolve) => {
    const p = spawn("sh", ["-c", `chmod -R u+w ${JSON.stringify(dir)} 2>/dev/null; rm -rf ${JSON.stringify(dir)}`], {
      stdio: "ignore",
    });
    p.on("close", resolve);
    p.on("error", resolve);
  });
}

// 内存里为每条流保留的尾部上限。
//
// 【必须有上限】（踩过）：把 stdout 一路 += 成字符串，跑评审任务时 pi 直接把 V8 的
// 字符串长度上限撑爆 —— `RangeError: Invalid string length`，整批在它那里崩掉，
// 前面几家的结果全部白跑。它的 --mode json 事件流会把工具读到的文件内容也吐出来。
//
// 取尾部而不是头部：各家的最终答案都在输出末尾。全量另有一份流式写到 runDir，
// 想重新解析随时能读。
const TAIL_BYTES = 16 * 1024 * 1024;

function tailCollector() {
  const chunks = [];
  let bytes = 0;
  return {
    push(buf) {
      chunks.push(buf);
      bytes += buf.length;
      while (bytes > TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift().length;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get bytes() {
      return bytes;
    },
  };
}

function spawnCapture(cmd, args, { cwd, env, timeoutMs, stdoutFile, stderrFile }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = tailCollector();
    const err = tailCollector();
    const outFile = stdoutFile ? createWriteStream(stdoutFile) : null;
    const errFile = stderrFile ? createWriteStream(stderrFile) : null;
    let outTotal = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // 先 SIGTERM 给 harness 一个收尾机会，5s 后再 SIGKILL。
      // 直接 KILL 会让「卡死恢复型」任务分不清「它自己卡住」和「我们砍early了」。
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      outTotal += d.length;
      out.push(d);
      outFile?.write(d);
    });
    child.stderr.on("data", (d) => {
      err.push(d);
      errFile?.write(d);
    });
    const finish = (code, extraErr = "") => {
      clearTimeout(timer);
      outFile?.end();
      errFile?.end();
      resolve({
        code,
        stdout: out.text(),
        stderr: err.text() + extraErr,
        timedOut,
        stdoutBytes: outTotal,
        stdoutTruncated: outTotal > out.bytes,
      });
    };
    child.on("error", (e) => finish(-1, `\nspawn error: ${e}`));
    child.on("close", (code) => finish(code));
  });
}
