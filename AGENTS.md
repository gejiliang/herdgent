# Herdgent — Agent 指令

> 只写「在这个目录里干活才需要的东西」，对所有 harness 通用。全局配置 `~/.agents/AGENTS.md` 已注入，不复述。
> 项目是什么、现状如何见 [`README.md`](README.md)；实测踩过的坑见 [`docs/findings-2026-07-31.md`](docs/findings-2026-07-31.md)。

## 不可逆约束

- **只管自己起的会话。** 只操作本插件 `workspace create` 出来的 workspace；**绝不按 label / agent 名去全局搜索**。GG 手起的会话（SPQR、mxweb、worldquant……）永远不在射程内。边界是结构性的，不是「记得过滤」。
- **零落盘到项目仓库。** 状态只写 `HERDR_PLUGIN_STATE_DIR`；给会话的上下文只经启动 argv（`--settings` / `--mcp-config`）注入，被管理的项目目录一个字节都不改。
- **不在 GG 的 `default` herdr 会话里做实验**——那是他正在干活的地方。用下面的隔离配方。
- **主键只用 harness 侧 session id**（claude 的 UUID）。herdr 的 `workspace_id` / `pane_id` / `terminal_id` 都会失效或变化，只能当本次寻址的临时句柄。

## 开发隔离配方（动手前先读）

plugin 安装是**用户全局**的（herdr 0.7.5 起），但**运行时可以完全隔离**——用命名会话：

```sh
# 起隔离的 herdr server：env 必须先擦干净，否则会继承当前 pane 的 HERDR_SOCKET_PATH 连回 default
env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    HERDR_SESSION=herdgentdev herdr server &

export HERDR_SOCKET_PATH=~/.config/herdr/sessions/herdgentdev/herdr.sock
export HERDR_PLUGIN_STATE_DIR=/tmp/herdgent-state      # 别用真状态目录

# 用完清理
herdr session stop herdgentdev && herdr session delete herdgentdev
```

**擦 env 是必须的**，不是保险动作：从一个 herdr pane 里起 server，它会继承 `HERDR_SOCKET_PATH` 并指回 default，于是你以为在隔离环境里做的事全落在 GG 的工作区。

**dev / prod 要不要分两套？** 不用建两套环境，herdr 已经给了三条隔离轴：
1. **plugin id** —— config/state 目录按 id 分（`herdr plugin config-dir <ID>`）。等到稳定版天天用、又要继续开发时，再让开发副本换个 id；现在只有 link 的开发副本，一个 id 够用。
2. **named session** —— 上面的配方，隔离 workspace/pane/agent。
3. **归属边界本身** —— dogfood 让它从第一天就是 load-bearing，漏了当天就知道。

不要提前建两套环境：那正是 SPQR v2 的死法（为未来可能的问题建设施）。

## 形态纪律

herdgent 是 **herdr plugin + 外部进程**，不 fork herdr、不改 herdr 核心。

**每加一处能力前先问：这能不能做成 plugin action / event / startup 钩子，或者做成 harness 侧的 hook？** 能就不碰 herdr 源码。fork 只在证明某个原语确实缺失时才考虑，且要留下证据。

理由：herdr 在快速迭代（0.7.5 才刚加 `[[startup]]` 与整套 agent CLI），fork 的长期成本是跟上游 diverge，而 plugin 路线可以 `herdr plugin install` 分发。

## 编排层的刹车

- 形状限死在「起会话 → 发提示 → 等状态 → 读输出 → 决定下一步」。
- **一旦开始出现「角色 / 工作流 / 协议 / 模板」这类名词就停手**——SPQR v2 的编排层 13k 行就是这些名词一个个长出来的，最后整层退役。
- **token 账单从第一版就要可见**：并行会话烧钱是静默的。

## 代码约定

- Node ESM（`.mjs`），**零 npm 依赖**——这样 `herdr plugin link` 不需要 `[[build]]` 步骤，改完下次调用即生效。
- `lib/herdr.mjs` 是唯一与 herdr 对话的地方；错误分三类且不压平：`spawn_failed`（herdr 没跑）/ `bad_output`（协议变了）/ herdr 自己的错误码。
- 钩子进程（`bin/hook-*.mjs`）**绝不能抛异常**——它跑在 harness 启动路径上，抛了会拖垮会话。失败要 `auditLog` 留痕，不能静默。
