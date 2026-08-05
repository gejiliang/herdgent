// herdr CLI 的薄封装。大多数请求走 CLI；只有 `agent.read` 的 truncated 元数据
// 没有 CLI 出口，才由 lib/events.mjs 走一次性 socket 请求。
import { spawnSync } from "node:child_process";

const BIN = process.env.HERDR_BIN_PATH || "herdr";

// 错误分三类且不压平：spawn 失败 / 输出不是 JSON / server 返回的业务错误码。
// 调用方需要区分「herdr 没跑起来」和「herdr 说 pane 不存在」。
export function herdr(args) {
  const r = spawnSync(BIN, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    throw Object.assign(new Error(`herdr spawn failed: ${r.error.message}`), { code: "spawn_failed" });
  }
  // herdr 把成功结果打到 stdout、错误信封打到 stderr，两边都要看。
  const raw = ((r.stdout || "").trim() || (r.stderr || "").trim());
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error(`herdr returned non-JSON (exit ${r.status}): ${raw.slice(0, 300)}`), { code: "bad_output" });
  }
  if (parsed.error) {
    throw Object.assign(new Error(`${parsed.error.code}: ${parsed.error.message}`), { code: parsed.error.code });
  }
  return parsed.result;
}

// 少数命令返回【纯文本】而不是 JSON——`agent read` / `pane read` 吐的是终端内容本身。
// 拿 herdr() 去解析它必然抛 bad_output，所以这些必须走这条路。
// 失败时 herdr 仍然把 JSON 错误信封打到 stderr，照旧要分辨。
export function herdrText(args) {
  const r = spawnSync(BIN, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    throw Object.assign(new Error(`herdr spawn failed: ${r.error.message}`), { code: "spawn_failed" });
  }
  const err = (r.stderr || "").trim();
  if (err.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(err);
    } catch {
      parsed = null;
    }
    if (parsed?.error) {
      throw Object.assign(new Error(`${parsed.error.code}: ${parsed.error.message}`), {
        code: parsed.error.code,
      });
    }
  }
  if (r.status !== 0) {
    throw Object.assign(new Error(`herdr exited ${r.status}: ${err.slice(0, 200)}`), {
      code: "command_failed",
    });
  }
  return r.stdout || "";
}

export function tryHerdr(args) {
  try {
    return { ok: true, result: herdr(args) };
  } catch (e) {
    return { ok: false, code: e.code || "unknown", message: e.message };
  }
}

// 同步 sleep：这些脚本都是一次性短命进程，没必要引入 async 复杂度。
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// `workspace create` / `tab create` 返回时 pane 里的 shell 还没到交互提示符，
// 紧接着 `agent start` 会报 agent_pane_busy（"not an available shell"）。
// 手工分步操作时感觉不到，脚本连发必踩。
export function waitForShell(paneId, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "never probed";
  while (Date.now() < deadline) {
    const r = tryHerdr(["pane", "process-info", "--pane", paneId]);
    if (r.ok) {
      const info = r.result.process_info;
      const fg = info?.foreground_processes ?? [];
      const isShell = fg.length > 0 && fg.every((p) => /^(-?)(zsh|bash|sh|fish)$/.test(p.name));
      if (info?.shell_pid && isShell) return info;
      last = `shell_pid=${info?.shell_pid} fg=${fg.map((p) => p.name).join(",") || "none"}`;
    } else {
      last = `${r.code}: ${r.message}`;
    }
    sleepSync(intervalMs);
  }
  throw Object.assign(new Error(`pane ${paneId} never reached a shell prompt within ${timeoutMs}ms (last: ${last})`), {
    code: "shell_not_ready",
  });
}

// pane 到达提示符的判据由 herdr 自己定（它要的是"空闲在提示符"，不是"shell 进程存在"）。
// 与其猜它的判据，不如按它的回答重试：agent_pane_busy 是可恢复的，其它错误立即上抛。
export function startAgentWhenReady(args, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return herdr(args);
    } catch (e) {
      // ⚠️ 起不来和【起慢了】要分开。herdr 的 agent start 自带就绪等待
      //（--timeout，默认 30s，上限 300s），超时它会报错——但那时 agent
      // 往往【已经在跑了】，只是还没被判定为 interactive_ready。并发起一批
      // pi worker 时尤其容易撞到这个临界点。
      //
      // 早先直接把这个异常当作启动失败，于是 registry 记 failed、编排层认定它死了，
      // 而真实的 agent 还在那儿烧额度，还不在任何回收路径里——静默泄漏。
      //
      // 所以抛之前先回查一次：pane 上真有 agent 就当成功，把 herdr 的记录接过来。
      const recovered = recoverStartedAgent(args);
      if (recovered) return recovered;
      if (e.code !== "agent_pane_busy" || Date.now() >= deadline) throw e;
      sleepSync(intervalMs);
    }
  }
}

// agent start 报错后，回查它是不是其实已经起来了。
// 返回值刻意跟 `agent start` 成功时同形（{ agent: … }），调用方不用分两条路。
function recoverStartedAgent(args) {
  const i = args.indexOf("--pane");
  const paneId = i !== -1 ? args[i + 1] : null;
  if (!paneId) return null;
  const r = tryHerdr(["agent", "get", paneId]);
  if (!r.ok) return null;
  const agent = r.result?.agent;
  // 有 agent_session 才算真起来了：光有 pane 记录不够，那可能是上一个 agent 的残留。
  if (!agent?.agent_session?.value) return null;
  const wanted = args[args.indexOf("--kind") + 1];
  if (wanted && agent.agent !== wanted) return null; // pane 上是别的 agent，不是我们要的
  return { agent, recovered: true };
}
