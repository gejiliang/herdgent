# Herdgent — Agent 指令

> **本文件是本项目章程的唯一真源**，`CLAUDE.md` 只是指向它的软链——改章程改本文件。
> 只写「在这个目录里干活才需要的东西」；harness 独有的落点写进末尾对应小节。全局配置 `~/.agents/AGENTS.md` 已注入，不复述。
> 项目是什么、现状如何见 [`README.md`](README.md)；实测踩过的坑见 [`docs/findings-2026-07-31.md`](docs/findings-2026-07-31.md)（0.7.5 时代）与 [`docs/findings-2026-08-05.md`](docs/findings-2026-08-05.md)（0.8.0 时代，含许可证变更与新的可观测面）。

## 不可逆约束

- **只管自己起的会话。** 只操作本插件建出来的 workspace；**绝不按 label / agent 名去全局搜索**。GG 手起的会话（SPQR、mxweb、worldquant……）永远不在射程内。边界是结构性的，不是「记得过滤」。编排会一次起一批 worker，这条只会更吃紧。
- **不改被管理项目的源码与配置。** herdgent 自己的东西全在 `~/.herdgent`（代码 / config / state，见 `lib/paths.mjs`）；给会话的上下文只经启动 argv（`--settings` / `--mcp-config`）注入，两者实测均为**合并**语义，不会覆盖用户自己的配置。
  worktree 也不算例外——实测 checkout 落在 `~/.herdr/worktrees/<repo>/<branch>`，项目仓库只多 `.git/worktrees/` 元数据。但**只能经 `herdr worktree create` / `remove` 进出**，且 `remove` 不删分支，收尾要补 `git branch -D`，否则每次编排都在用户仓库里留一个分支。
- **主键只用 harness 侧 session id**（claude 的 UUID）。herdr 的 `workspace_id` / `pane_id` / `terminal_id` 都会失效或变化，只能当本次寻址的临时句柄。
- **破坏性实验用命名会话**（配方见下）。日常 dogfood 就在 `default` 里跑——插件本来就是用户全局的，而且让归属边界从第一天就 load-bearing 正是目的。只有「可能起一堆东西 / 可能删错东西」的实验才需要隔离。

- ⚠️ **任何会调到 `spawn_worker` / `startManagedSession` 的测试，必须把 `HERDR_SOCKET_PATH` 指到隔离 socket 或一个不存在的路径。**
  「以为它连不上」不算数——**已经翻过一次车**：`test/identity.mjs` 里设了 `HERDR_SOCKET_PATH: ""`，
  但空字符串是 falsy，`herdr` CLI 于是回落到 default session，在 GG 的工作区里建了 5 个 workspace、
  起了 5 个 claude、烧了额度，其中一个还停在 `blocked` 等输入。
  判据是**结构性**的：测试进程根本连不上真 herdr，而不是「测试逻辑应该不会走到那一步」。

## 开发隔离配方（动手前先读）

plugin 安装是**用户全局**的（herdr 0.7.5 起），但**运行时可以完全隔离**——用命名会话：

```sh
# 起隔离的 herdr server。两件事都是必须的：
#   · env 擦干净——否则继承当前 pane 的 HERDR_SOCKET_PATH，连回 default
#   · HERDGENT_STATE_DIR——把整个 session 的 registry 挪到临时目录（见下）
env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID \
    -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_PID -u CLAUDE_EFFORT \
    HERDR_SESSION=herdgentdev HERDGENT_STATE_DIR=/tmp/hg-dev-state herdr server &

export HERDR_SOCKET_PATH=~/.config/herdr/sessions/herdgentdev/herdr.sock

# 用完清理：真状态目录一个字节都没被碰过
herdr session stop herdgentdev && herdr session delete herdgentdev
rm -rf /tmp/hg-dev-state
```

**擦 env 是必须的**，不是保险动作：从一个 herdr pane 里起 server，它会继承 `HERDR_SOCKET_PATH` 并指回 default，于是你以为在隔离环境里做的事全落在 GG 的工作区。

**同时要擦 `CLAUDE_CODE_*` / `CLAUDECODE` / `CLAUDE_PID`**（若从 Claude Code 里起 server）：server 把自己的环境传给它起的每个 pane 和 agent，脏 env 会让受管会话关掉 transcript、标题串台，`transcript_path` 也就拿不到了。

**state 怎么隔离**（实测 2026-08-01）：

- ❌ `HERDR_PLUGIN_STATE_DIR` 没用。它是 herdr **注入**给插件命令的，不是读取的——export 什么都会被覆盖成 `~/.local/state/herdr/plugins/<plugin-id>/`。
- ✅ **`HERDGENT_STATE_DIR` 有用**，因为那是 herdgent 自己的变量（`lib/paths.mjs` 里优先级最高），herdr 不认识它、也就不会覆盖。默认值是 `~/.herdgent/state`，设了它就整体改写。
  在**起 server 时**设上，它会一路穿到这个 session 的每一处：plugin action → worker 会话 → 全局注册的 MCP server。
  实测：dev session 里的 plugin 读到的是临时目录的 registry，同一时刻 default session 读到的是真表，两边互不可见。

→ 所以**不需要给开发副本换 plugin id**。一条环境变量就够，而且清理只是 `rm -rf /tmp/hg-dev-state`。

**dev / prod 已经分开了**（2026-08-01 起，GG 开始天天用之后才分的，不是提前建的）：

| | 位置 | state |
|---|---|---|
| GG 用的 | `~/.herdgent`（`bin/install.mjs` 同步过去） | `~/.herdgent/state` |
| 开发 | 本仓库 | `/tmp/hg-dev-state`（命名 session 里设 `HERDGENT_STATE_DIR`） |

**改完代码不会自动生效**——MCP 配置里存的是 `~/.herdgent` 的绝对路径。
要让 GG 用上得显式 `npm run install-local`，这一步是故意的：不然半成品会直接砸到他正在用的会话上。

隔离靠两条轴，不需要第三条（换 plugin id 那条已作废，见上）：
1. **named session + `HERDGENT_STATE_DIR`** —— 隔离 workspace/pane/agent 与整张 registry。
2. **归属边界本身** —— dogfood 让它从第一天就是 load-bearing，漏了当天就知道。

## 形态纪律

herdgent 是 **herdr plugin + 外部进程**，不 fork herdr、不改 herdr 核心。

**每加一处能力前先问：这能不能做成 plugin action / event / startup 钩子，或者做成 harness 侧的 hook？** 能就不碰 herdr 源码。fork 只在证明某个原语确实缺失时才考虑，且要留下证据。

理由：herdr 在快速迭代（0.7.5 才刚加 `[[startup]]` 与整套 agent CLI），fork 的长期成本是跟上游 diverge，而 plugin 路线可以 `herdr plugin install` 分发。

注意这不 fork 是**纯工程判断**：herdr 自 0.8.0 起与 herdgent 同为 Apache-2.0（之前为 AGPL），许可证从来只是附带的约束、不是论证本身。

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

## 仅 Claude Code 适用

- 本项目的控制面钩子（`bin/hook-claude.mjs`）经 `--settings` 注入被管理的会话，**与用户自己的 `~/.claude/settings.json` 是合并语义**（实测，见 [`docs/findings-2026-07-31.md`](docs/findings-2026-07-31.md)）。改钩子注入逻辑前先确认这条仍成立。
- 调试受管会话时注意：被起的 claude 会**继承起它那个进程的环境变量**。用干净 env 起 runtime，否则会把 `CLAUDE_CODE_*` 一路传进去（症状：状态栏出现「Transcript saving is off — inherited CLAUDE_CODE_…」、会话标题串台）。
