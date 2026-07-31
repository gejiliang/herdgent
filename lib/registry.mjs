// 受管会话登记表。
//
// 主键用 harness 侧的 session id（claude 的 UUID），绝不用 herdr 的 workspace/pane/terminal id：
// 实测 HERDR_WORKSPACE_ID=w6 在同一会话存续期间就已失效（workspace_not_found），
// terminal_id 每次 server 重启必变。详见 docs/findings-2026-07-31.md。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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

export function load() {
  try {
    return JSON.parse(readFileSync(registryFile(), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { version: 1, sessions: {} };
    throw e;
  }
}

export function save(reg) {
  stateDir();
  const tmp = `${registryFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, registryFile()); // 原子替换：startup 对账与 action 写入可能撞车
}

export function put(patch) {
  const reg = load();
  reg.sessions[patch.key] = { ...(reg.sessions[patch.key] || {}), ...patch };
  save(reg);
  return reg.sessions[patch.key];
}

export function list() {
  return Object.values(load().sessions);
}

// 钩子跑在 harness 进程里，出错既不能抛也不能没声音——留痕到状态目录。
export function auditLog(line) {
  try {
    appendFileSync(join(stateDir(), "hook.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 留痕本身失败时不再升级：绝不让审计把 harness 启动搞挂。
  }
}
