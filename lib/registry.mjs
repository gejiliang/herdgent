// 受管会话登记表。
//
// 主键用 harness 侧的 session id（claude 的 UUID），绝不用 herdr 的 workspace/pane/terminal id：
// 实测 HERDR_WORKSPACE_ID=w6 在同一会话存续期间就已失效（workspace_not_found），
// terminal_id 每次 server 重启必变。详见 docs/findings-2026-07-31.md。
//
// 编排上线后这张表【有多个并发写者】：每个 orchestrator 会话有自己的 MCP server 进程，
// 它们都要登记 worker。所以「读—改—写」必须在锁内做，否则 A 读、B 读、A 写、B 写 → A 的改动消失。
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// 目录必须【惰性】解析：钩子进程是被 harness 拉起来的，
// HERDR_PLUGIN_STATE_DIR 只注入插件命令、不会传进它启动的会话，
// 所以钩子要靠 HERDGENT_STATE_DIR 显式接力（见 bin/session-start.mjs）。
function stateRoot() {
  return (
    process.env.HERDGENT_STATE_DIR ||
    process.env.HERDR_PLUGIN_STATE_DIR ||
    join(homedir(), ".local/state/herdgent")
  );
}

function registryFile() {
  return join(stateRoot(), "registry.json");
}

export function stateDir() {
  const dir = stateRoot();
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 同步 sleep：registry 操作都是毫秒级的短临界区，引入 async 会让钩子和 action
// 这些一次性同步脚本全部变色。锁等待上限只有 2 秒，卡不住调用方。
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// mkdir 的原子性就是锁：目录已存在时必然抛 EEXIST，不存在竞态窗口。
// STALE_MS 是必需的，不是保险——持锁进程被 kill 掉不会释放锁，
// 没有过期回收的话整个插件会永久卡死。正常临界区在 10ms 内，10 秒足够宽松。
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10000;

export function withLock(fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const dir = stateDir();
  const lockDir = join(dir, "registry.lock");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;

      // 抢占过期锁。用 mtime 而不是锁内容：写内容有二次竞态，mkdir 的时间戳没有。
      let age = 0;
      try {
        age = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        continue; // 锁刚好被别人释放了，重试
      }
      if (age > staleMs) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // 别人抢先清了，无所谓
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error(`registry lock busy for ${timeoutMs}ms (holder age ${age}ms)`),
          { code: "lock_timeout" },
        );
      }
      sleepSync(15);
    }
  }

  // 持锁者留 pid，卡住时能直接看出是谁。写失败不影响锁本身。
  try {
    writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
  } catch {
    // 诊断信息而已，不值得让操作失败
  }

  try {
    return fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // 释放失败就等它过期，比抛异常盖住 fn 的真实错误好
    }
  }
}

const EMPTY = { version: 2, sessions: {}, orchestrations: {} };

export function load() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(registryFile(), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { ...EMPTY, sessions: {}, orchestrations: {} };
    throw e;
  }
  // v1 没有 orchestrations；就地补齐，不做迁移脚本。
  return { version: 2, sessions: raw.sessions || {}, orchestrations: raw.orchestrations || {} };
}

export function save(reg) {
  stateDir();
  const tmp = `${registryFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, registryFile()); // 原子替换：即使锁失效也不会读到半个文件
}

// 唯一的写入口。所有「读—改—写」都必须走这里，绕过去就会丢更新。
export function update(fn) {
  return withLock(() => {
    const reg = load();
    const result = fn(reg);
    save(reg);
    return result;
  });
}

export function put(patch) {
  return update((reg) => {
    reg.sessions[patch.key] = { ...(reg.sessions[patch.key] || {}), ...patch };
    return reg.sessions[patch.key];
  });
}

export function list() {
  return Object.values(load().sessions);
}

// 一次编排的元数据。max_workers 由用户在 orchestrate 启动时选，存在这里而不是
// 存在代码里——每次编排的规模不一样，写死会挡住合理的大扇出。
export function putOrchestration(root, patch) {
  return update((reg) => {
    reg.orchestrations[root] = { ...(reg.orchestrations[root] || {}), root, ...patch };
    return reg.orchestrations[root];
  });
}

export function getOrchestration(root) {
  return load().orchestrations[root] || null;
}

const LIVE_STATUSES = new Set(["starting", "active"]);

function isLiveWorker(s) {
  return s.role === "worker" && LIVE_STATUSES.has(s.status);
}

// 并发计数。global 不做硬拦截——「我这个编排只起了 2 个却被拒」会让人莫名其妙。
// 但数字要一路报到 orchestrator 面前，失控时它和人都看得见。
export function countLive(root) {
  const rows = Object.values(load().sessions);
  return {
    global: rows.filter(isLiveWorker).length,
    inRoot: root ? rows.filter((s) => isLiveWorker(s) && s.root === root).length : 0,
  };
}

// 钩子跑在 harness 进程里，出错既不能抛也不能没声音——留痕到状态目录。
export function auditLog(line) {
  try {
    appendFileSync(join(stateDir(), "hook.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 留痕本身失败时不再升级：绝不让审计把 harness 启动搞挂。
  }
}
