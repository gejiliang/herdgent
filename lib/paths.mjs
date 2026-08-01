// herdgent 的所有落盘位置，统一收在一处解析。
//
// 布局：
//   ~/.herdgent/                    HERDGENT_HOME
//   ├── bin/ lib/ skills/           代码 + 内置编排 skill（install 会覆盖这些）
//   ├── config/                     【用户的东西，install 绝不动】
//   │   ├── profiles.json           自定义 worker profile
//   │   └── workflows/*.md          自定义编排工作流
//   └── state/                      registry.json、各会话的 settings、日志
//
// 【为什么不用 herdr 注入的 HERDR_PLUGIN_STATE_DIR / CONFIG_DIR】：
// herdgent 有三条启动路径——plugin action（herdr 注入那两个变量）、全局注册的
// MCP server（什么都不注入）、裸终端 CLI 会话（同上）。跟着 herdr 的注入走，
// 就会出现 plugin action 写 herdr 的目录、MCP server 写另一个，registry 分裂成
// 两张表，一边派出去的 worker 另一边看不见。所以自己定家目录，三条路都指同一处。
import { join } from "node:path";
import { homedir } from "node:os";

export function herdgentHome() {
  return process.env.HERDGENT_HOME || join(homedir(), ".herdgent");
}

// HERDGENT_STATE_DIR 是【开发隔离】的口子：起 herdr server 时设上，
// 那个 session 的 plugin action / worker / MCP server 全部改写到临时目录，
// 真状态目录一个字节都不会被碰（见 AGENTS.md 的隔离配方）。
export function stateRoot() {
  return process.env.HERDGENT_STATE_DIR || join(herdgentHome(), "state");
}

export function configRoot() {
  return process.env.HERDGENT_CONFIG_DIR || join(herdgentHome(), "config");
}

// 用户自定义的编排工作流。工作流就是 prompt——「谁评审谁、什么算验收」这类语义
// 只能活在这里，不能进代码（AGENTS.md 的编排层边界）。所以它天然是用户可写的，
// 放 config 下而不是跟内置 skill 混在一起，install 才不会覆盖掉。
export function workflowsRoot() {
  return join(configRoot(), "workflows");
}

// 0.4.0 之前 state 跟着 herdr 的插件目录走、config 跟着 herdr 的插件配置目录走。
// install 时拿这两个路径检查有没有遗留数据，提示用户自己搬——不自动搬，
// 免得把两份都当真的合并出一张诡异的表。
export function legacyPaths() {
  return {
    state: join(homedir(), ".local/state/herdr/plugins/herdgent"),
    config: join(homedir(), ".config/herdr/plugins/config/herdgent"),
  };
}
