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
import { stateRoot as resolveStateRoot } from "./paths.mjs";

// 路径统一在 lib/paths.mjs 解析，且必须【惰性】——钩子进程是被 harness 拉起来的，
// 环境要到调用那一刻才齐（见 bin/hook-claude.mjs 的 --state-dir 接力）。
const stateRoot = resolveStateRoot;

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

// 一次编排的元数据。max_workers_explicit 只由 set_worker_limit 写，存在这里而不是
// 存在代码里——每次编排的规模不一样，写死会挡住合理的大扇出。历史 max_workers 是
// 旧启动路径留下的默认值，保留兼容旧 registry，但绝不能再作为上限判据。
export function putOrchestration(root, patch) {
  return update((reg) => {
    reg.orchestrations[root] = { ...(reg.orchestrations[root] || {}), root, ...patch };
    return reg.orchestrations[root];
  });
}

export function getOrchestration(root) {
  return load().orchestrations[root] || null;
}

// 「还占着一个位置」= 这个 worker 还归本次编排管。闸拦的是【同时开着多少会话】，
// 不只是【同时烧多少额度】——一个待命的 worker 照样占着 pane、上下文和人的注意力，
// 而且编排者随时可以 send_to_worker 让它接着干。
//
// ⚠️ 【必须是白名单】。status 只有五个写入点，取值域是封闭的：
//   starting（登记时）· active（agent 起来了）· terminated（显式除名）
//   · dead（对账发现 agent 没了）· failed（起不来）
// 曾经改成黑名单「不在 terminated/dead/failed 里就算 live」，结果早期版本留下的
// reclaimed 记录立刻变成幽灵，把并发数虚报成 3。黑名单要求穷举所有死法（含历史的），
// 白名单只要求穷举活法——而活法就两种。
//
// 【worker 跑完了 status 不变】，仍是 active：跑完不等于它没了。herdr 报的
// working/idle/done/blocked 写在 agent_status 那格，两件事不混在一起。
//
// 这里数的是 registry 里【记着】的状态，是缓存不是真相。真相在 herdr——
// 所以 spawn / list_workers 之前都要先走 lib/worker.mjs 的 reconcileLive() 对账，
// 把 agent 已经没了的标成 dead。原来缺的正是这一步（FIXME #1）：没人把消失的
// agent 从 active 改走，于是它永远占着额度，撞上限时还看不出是被谁占的。
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

// 谁还占着位置——给对账用，拿得到 pane_id 才能去问 herdr。
export function liveWorkerRows(root = null) {
  return Object.values(load().sessions).filter((s) => isLiveWorker(s) && (!root || s.root === root));
}

// 钩子跑在 harness 进程里，出错既不能抛也不能没声音——留痕到状态目录。
export function auditLog(line) {
  try {
    appendFileSync(join(stateDir(), "hook.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 留痕本身失败时不再升级：绝不让审计把 harness 启动搞挂。
  }
}
