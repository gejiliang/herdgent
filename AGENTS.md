# Herdgent — Agent 指令

> 只写「在这个目录里干活才需要的东西」，对所有 harness 通用。全局配置 `~/.agents/AGENTS.md` 已注入，不复述。
> 项目是什么、现状如何见 [`README.md`](README.md)；实测踩过的坑见 [`docs/findings-2026-07-31.md`](docs/findings-2026-07-31.md)。

## 不可逆约束

- **只管自己起的会话。** 只操作本插件建出来的 workspace；**绝不按 label / agent 名去全局搜索**。GG 手起的会话（SPQR、mxweb、worldquant……）永远不在射程内。边界是结构性的，不是「记得过滤」。编排会一次起一批 worker，这条只会更吃紧。
- **不改被管理项目的源码与配置。** herdgent 自己的状态只写 `HERDR_PLUGIN_STATE_DIR`；给会话的上下文只经启动 argv（`--settings` / `--mcp-config`）注入，两者实测均为**合并**语义，不会覆盖用户自己的配置。
  worktree 也不算例外——实测 checkout 落在 `~/.herdr/worktrees/<repo>/<branch>`，项目仓库只多 `.git/worktrees/` 元数据。但**只能经 `herdr worktree create` / `remove` 进出**，且 `remove` 不删分支，收尾要补 `git branch -D`，否则每次编排都在用户仓库里留一个分支。
- **主键只用 harness 侧 session id**（claude 的 UUID）。herdr 的 `workspace_id` / `pane_id` / `terminal_id` 都会失效或变化，只能当本次寻址的临时句柄。
- **破坏性实验用命名会话**（配方见下）。日常 dogfood 就在 `default` 里跑——插件本来就是用户全局的，而且让归属边界从第一天就 load-bearing 正是目的。只有「可能起一堆东西 / 可能删错东西」的实验才需要隔离。

## 开发隔离配方（动手前先读）

plugin 安装是**用户全局**的（herdr 0.7.5 起），但**运行时可以完全隔离**——用命名会话：

```sh
# 起隔离的 herdr server：env 必须先擦干净，否则会继承当前 pane 的 HERDR_SOCKET_PATH 连回 default
env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    HERDR_SESSION=herdgentdev herdr server &

export HERDR_SOCKET_PATH=~/.config/herdr/sessions/herdgentdev/herdr.sock

# 用完清理（state 落在真目录，见下，dev 数据要手动清）
herdr session stop herdgentdev && herdr session delete herdgentdev
rm -rf ~/.local/state/herdr/plugins/herdgent/{registry.json,sessions,hook.log}
```

**擦 env 是必须的**，不是保险动作：从一个 herdr pane 里起 server，它会继承 `HERDR_SOCKET_PATH` 并指回 default，于是你以为在隔离环境里做的事全落在 GG 的工作区。

**同时要擦 `CLAUDE_CODE_*` / `CLAUDECODE` / `CLAUDE_PID`**（若从 Claude Code 里起 server）：server 把自己的环境传给它起的每个 pane 和 agent，脏 env 会让受管会话关掉 transcript、标题串台，`transcript_path` 也就拿不到了。

⚠️ **`HERDR_PLUGIN_STATE_DIR` 不能用来隔离 state（实测 2026-07-31）。** 它是 herdr **注入**给插件命令的，不是读取的——你 export 什么都会被覆盖成 `~/.local/state/herdr/plugins/<plugin-id>/`。所以命名会话隔离的是 workspace/pane/agent，**不隔离 registry**：dev 跑出来的登记记录会落进真状态目录，用完手动清（见上）。要真隔离 state 只有换 plugin id 这一条路。

**dev / prod 要不要分两套？** 不用建两套环境，herdr 已经给了三条隔离轴：
1. **plugin id** —— config/state 目录按 id 分（`herdr plugin config-dir <ID>`）。等到稳定版天天用、又要继续开发时，再让开发副本换个 id；现在只有 link 的开发副本，一个 id 够用。
2. **named session** —— 上面的配方，隔离 workspace/pane/agent。
3. **归属边界本身** —— dogfood 让它从第一天就是 load-bearing，漏了当天就知道。

不要提前建两套环境：那正是 SPQR v2 的死法（为未来可能的问题建设施）。

## 形态纪律

herdgent 是 **herdr plugin + 外部进程**，不 fork herdr、不改 herdr 核心。

**每加一处能力前先问：这能不能做成 plugin action / event / startup 钩子，或者做成 harness 侧的 hook？** 能就不碰 herdr 源码。fork 只在证明某个原语确实缺失时才考虑，且要留下证据。

理由：herdr 在快速迭代（0.7.5 才刚加 `[[startup]]` 与整套 agent CLI），fork 的长期成本是跟上游 diverge，而 plugin 路线可以 `herdr plugin install` 分发。

## 编排层的边界

herdgent 的产品形态就是跨 harness 编排（见 README），所以「不做编排」不是纪律。纪律是**编排的语义不进 herdgent 的代码**。

- **代码只提供动词**：起 worker、派任务、收结果、取消、列出。仅此而已。
- **语义活在 prompt / skill / workflow 脚本里**——谁是 tech lead、什么归实现什么归评审、跨厂商互审怎么配对，全部是编排者自己的事，herdgent 不认识这些概念。
- **判据**：herdgent 代码里出现 `Role` / `Workflow` / `Protocol` / `Template` 这类**类型定义**就是越界。prompt 里写满角色分工是正常的。
  参照物：omnigent 的 polly 有完整的多 agent 编排能力，而它的 `config.yaml` 里真正的代码只有「声明 6 个子 agent + 3 条 guardrail + 4 个开关」，其余整段是自然语言 prompt。SPQR v2 的 13k 行死在把同样的语义固化成了类型。
- **spawn 必须有硬上限**，写死在工具里，不做成配置。参照：polly 每轮 6 个派发，Claude Code dynamic workflow 是 16 并发 / 1000 总量，Codex 是 `max_threads 6` / `max_depth 1`。并行会话失控是静默的。

## 代码约定

- Node ESM（`.mjs`），**零 npm 依赖**。理由是 `herdr plugin link` 不跑 `[[build]]`，零依赖才能改完下次调用即生效；不是洁癖。真要引入依赖，先算清楚它值不值一个 build 步骤。
- `lib/herdr.mjs` 是唯一与 herdr 对话的地方；错误分三类且不压平：`spawn_failed`（herdr 没跑）/ `bad_output`（协议变了）/ herdr 自己的错误码。
- 钩子进程（`bin/hook-*.mjs`）**绝不能抛异常**——它跑在 harness 启动路径上，抛了会拖垮会话。失败要 `auditLog` 留痕，不能静默。
