# Herdgent — Agent 指令

> **本文件是本项目章程的唯一真源**，`CLAUDE.md` 只是指向它的软链——改章程改本文件。
> 只写「在这个目录里干活才需要的东西」；harness 独有的落点写进末尾对应小节。全局配置 `~/.agents/AGENTS.md` 已注入，不复述。
> 项目是什么、现状如何见 [`README.md`](README.md)；实测踩过的坑见 [`docs/findings-2026-07-31.md`](docs/findings-2026-07-31.md)（0.7.5 时代）与 [`docs/findings-2026-08-05.md`](docs/findings-2026-08-05.md)（0.8.0 时代，含许可证变更与新的可观测面）与 [`docs/findings-2026-09-08.md`](docs/findings-2026-09-08.md)（0.9.0 时代：提交语义与 blocked 契约）；
> 两个编排参照物的实测画像见 [`docs/orchestrators-compared.md`](docs/orchestrators-compared.md)；
> 哪些模型现在真的能跑（以及为什么 OpenAI 整条线不在表里了）见 [`docs/model-availability-2026-08-12.md`](docs/model-availability-2026-08-12.md)；
> dsh 与 pi 的 headless 能力实测（配置在线上对齐；含 pi 只读档不成边界这一条）见 [`docs/harness-dsh-vs-pi-2026-08-15.md`](docs/harness-dsh-vs-pi-2026-08-15.md)。

## 不可逆约束

- **只管自己起的会话。** 只操作本插件建出来的 workspace；**绝不按 label / agent 名去全局搜索**。GG 手起的会话（SPQR、mxweb、worldquant……）永远不在射程内。边界是结构性的，不是「记得过滤」。编排会一次起一批 worker，这条只会更吃紧。
- **不改被管理项目的源码与配置。** herdgent 自己的东西全在 `~/.herdgent`（代码 / config / state，见 `lib/paths.mjs`）；给会话的上下文只经启动 argv（`--settings` / `--mcp-config`）注入，两者实测均为**合并**语义，不会覆盖用户自己的配置。
  worktree 也不算例外——实测 checkout 落在 `~/.herdr/worktrees/<repo>/<branch>`，项目仓库只多 `.git/worktrees/` 元数据。但**只能经 `herdr worktree create` / `remove` 进出**，且 `remove` 不删分支，收尾要补 `git branch -d`（**只用安全的 -d，永远不用 -D**——未合并的分支让 git 自己拒），否则每次编排都在用户仓库里留一个分支。
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

**改完代码不会自动生效**——MCP 配置里存的是 `~/.herdgent` 的绝对路径，得跑 `npm run install-local` 同步。

**保持 `~/.herdgent` 最新是默认动作**（GG 定，2026-08-06）：改动合并进 main 之后就装，不用问。但有两个前提，缺一不可——它们正是「显式安装」这一步当初存在的理由：

1. **已经合并进 main**。半成品不装，否则会直接砸到 GG 正在用的会话上。
2. **没有活着的编排**（`list_workers` 的 `live` 为 0）。install 会替换 `~/.herdgent` 下的运行时文件，而**正在跑的 MCP server 就是从那里加载的**——编排跑到一半装，等于抽掉它脚下的地板，只能靠 herdr CLI 手工收场。

装完还有一层：**已经开着的会话不会加载新版本**。MCP server 是 harness 进程的 stdio 子进程，`/clear`、`/new` 都不重启它，必须完全退出 harness 再起。所以「装了」不等于「当前会话生效了」，报告时要说清这条。

隔离靠两条轴，不需要第三条（换 plugin id 那条已作废，见上）：
1. **named session + `HERDGENT_STATE_DIR`** —— 隔离 workspace/pane/agent 与整张 registry。
2. **归属边界本身** —— dogfood 让它从第一天就是 load-bearing，漏了当天就知道。

## 形态纪律

herdgent 是 **herdr plugin + 外部进程**，不 fork herdr、不改 herdr 核心。

**每加一处能力前先问：这能不能做成 plugin action / event / startup 钩子，或者做成 harness 侧的 hook？** 能就不碰 herdr 源码。fork 只在证明某个原语确实缺失时才考虑，且要留下证据。

理由：herdr 在快速迭代（0.7.5 才刚加 `[[startup]]` 与整套 agent CLI），fork 的长期成本是跟上游 diverge，而 plugin 路线可以 `herdr plugin install` 分发。

注意这不 fork 是**纯工程判断**：herdr 自 0.8.0 起与 herdgent 同为 Apache-2.0（之前为 AGPL），许可证从来只是附带的约束、不是论证本身。

### 只跟最新版 herdr，不做向后兼容（GG 定）

支持下限就是当前用的那一版（`herdr-plugin.toml` 的 `min_herdr_version` 与 `bin/install.mjs` 的 `MIN_HERDR` 是真源，两处必须同步）。上游行为变了就**重验并跟进**，不留兼容分支——多一个口径就是多一条要维护、且几乎跑不到的路径。

**但判据必须标明版本**。教训是实测出来的：herdr 0.7.5 → 0.8.0 之间，server 重启后的恢复行为**整个反转**了——

| | `agent get`（死 agent） | `pane process-info`（死 agent） |
|---|---|---|
| 0.7.5 | 幽灵：仍报 `idle` + `interactive_ready` | `pane_not_found` |
| 0.8.0 | 诚实：`agent_not_found` | **成功返回**（pane 被恢复成活 shell） |

于是 0.7.5 时代定的「`process-info` 探得活就算活」在 0.8.0 下把死 agent 判成了活的（FIXME #1 的病复发）。**换判据前先问它依赖上游的哪条行为、那条行为在哪个版本上验过**。实测见 [`docs/findings-2026-08-05.md`](docs/findings-2026-08-05.md) 第五节。

## 编排层的边界

herdgent 的产品形态就是跨 harness 编排（见 README），所以「不做编排」不是纪律。纪律是**编排的语义不进 herdgent 的代码**。

- **代码只提供动词**：起 worker、派任务、收结果、取消、列出。仅此而已。
- **语义活在 prompt / skill / workflow 脚本里**——谁是 tech lead、什么归实现什么归评审、跨厂商互审怎么配对，全部是编排者自己的事，herdgent 不认识这些概念。
- **判据**：herdgent 代码里出现 `Role` / `Workflow` / `Protocol` / `Template` 这类**类型定义**就是越界。prompt 里写满角色分工是正常的。
  参照物：omnigent 的 polly 有完整的多 agent 编排能力，而它的 `config.yaml` 里真正的代码只有「声明 6 个子 agent + 3 条 guardrail + 4 个开关」，其余整段是自然语言 prompt。SPQR v2 的 13k 行死在把同样的语义固化成了类型。
- **spawn 必须有硬上限，且上限本身是可配置项**（GG 定）。并行会话失控是静默的，所以闸门不能没有；但每次编排的规模不一样，写死会挡住合理的大扇出。实现分两层：
  - **默认值**：`DEFAULT_MAX_WORKERS`（现为 16，对齐 Claude Code dynamic workflow 的 16 并发），启动可用 `--max-workers` 覆盖。参照：polly 每轮 6 个派发，Codex 是 `max_threads 6` / `max_depth 1`。
  - **运行时可调**：`set_worker_limit`，范围 1–50，那个 50 才是写死在工具里的硬上界。值存 registry 的 `max_workers_explicit`，每次 spawn 现读——**人显式设过的才粘住**，没设过的每次启动都跟随当时的默认值。
    ⚠️ 键名是 `max_workers_explicit` 而不是 `max_workers`，这是踩出来的：旧实现里启动登记会把已有 `max_workers` 原样写回，于是「那一格存在」既可能是人设的、也可能只是上次启动写的，两者无法区分——**改 `DEFAULT_MAX_WORKERS` 对每个跑过编排的 repo 都静默无效**（实测 registry 里 29 条记录有 24 条钉着旧默认值 6）。旧键仍留在盘上但已不是判据。

## 用户配置放哪（两个 `config.json` 同名不同文件，别写错）

| 文件 | 谁读 | 现有键 |
|---|---|---|
| `~/.herdgent/config/config.json` | herdgent 自己（`lib/config.mjs`） | `cleanup_after_accept` |
| herdr 注入的 `HERDR_PLUGIN_CONFIG_DIR/config.json` | plugin action（`lib/profiles.mjs` 的 `sessionStartProfile`） | `session_start_profile` |

同目录下还有 `profiles.json`（worker profile）与 `workflows/*.md`（自定义编排 playbook）。**`install` 不覆盖这个目录里的任何东西。**

`cleanup_after_accept`：`auto`（默认）/ `keep`，决定 `finalize_run` 验收通过之后收不收那个 run 的容器。**消费者是 `finalize_run`（代码），有安全契约但没有原子保证**：显式 `verdict: "accept"` + 外部传入的 evidence（严格 string，不解析 worker 输出里的 PASS）、rex 用 `git merge-base --is-ancestor` 核验并入指定 base、脏 / 未合并一律拒绝、只清 run 台账登记的对象、发现外来 pane/tab 拒删、分支只用 `git branch -d`、每次尝试（含重试）先落 in_progress 日志再动手、幂等可重试。**边界要说清**：归属扫描与删除之间是 TOCTOU 的——扫完到 remove 的毫秒级窗口里混进的对象不在防御范围内，这是 best-effort 护栏叠在结构边界上，不是事务；`auto` 的语义也只是【这一次显式 finalize 之后收】，不存在无人值守的自动清扫。**GG 2026-09-16 明确批准推翻旧的 keep 默认与「MCP 通道无删除动词」（issue #2）决定**——删除不再是禁忌，但只存在 `finalize_run` 这一条带核验的路径。`keep` 是显式例外：标 accepted、留现场给人看。缺文件 / 坏 JSON / 缺键 / 值非法一律回 `auto`。值经 `orchestration_guide` 的返回送达。失败 / 未验收的 run 永不自动清。

## 代码约定

- Node ESM（`.mjs`），**零 npm 依赖**。理由是 `herdr plugin link` 不跑 `[[build]]`，零依赖才能改完下次调用即生效；不是洁癖。真要引入依赖，先算清楚它值不值一个 build 步骤。
- `lib/herdr.mjs` 是唯一与 herdr 对话的地方；错误分三类且不压平：`spawn_failed`（herdr 没跑）/ `bad_output`（协议变了）/ herdr 自己的错误码。
- 钩子进程（`bin/hook-*.mjs`）**绝不能抛异常**——它跑在 harness 启动路径上，抛了会拖垮会话。失败要 `auditLog` 留痕，不能静默。

## 仅 Claude Code 适用

- 本项目的控制面钩子（`bin/hook-claude.mjs`）经 `--settings` 注入被管理的会话，**与用户自己的 `~/.claude/settings.json` 是合并语义**（实测，见 [`docs/findings-2026-07-31.md`](docs/findings-2026-07-31.md)）。改钩子注入逻辑前先确认这条仍成立。
- 调试受管会话时注意：被起的 claude 会**继承起它那个进程的环境变量**。用干净 env 起 runtime，否则会把 `CLAUDE_CODE_*` 一路传进去（症状：状态栏出现「Transcript saving is off — inherited CLAUDE_CODE_…」、会话标题串台）。
