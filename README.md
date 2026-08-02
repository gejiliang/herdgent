# Herdgent

**跨 harness 的多 agent 编排器**，worker 跑在 [herdr](https://herdr.dev) 的真终端里——你随时能看、能直接打字接管。

形态是 **herdr plugin + 外部进程**：不 fork herdr、不改 herdr 核心，可经 `herdr plugin install` 分发。

## 它在解决什么

现有的多 agent 编排各差一块：

| | 跨 harness | worker 是真终端 | 控制流 |
|---|---|---|---|
| omnigent polly | ✅ 6 家 | ❌ SDK/桥接重建的视图 | prompt |
| Claude Code dynamic workflow | ❌ 只有 Claude subagent | ❌ | 确定性脚本 |
| Codex multi-agent v2 | ❌ 只有 Codex | ❌ | 对话；且 v2 不再暴露父子间指令 |
| **herdgent** | ✅ herdr 支持 21 家 | ✅ 一个 worker 一个 pane | 编排者自己定 |

herdgent 不选控制流范式——它只提供动词，编排逻辑是使用者的 skill / prompt / workflow 脚本。

## 与 omnigent 的对照

omnigent 是参照物（Apache-2.0，Databricks + Neon）。只借设计，不搬代码。

| omnigent 的东西 | herdgent |
|---|---|
| tmux 终端底座 | **herdr**（socket API） |
| 自有 web / iOS / Slack 客户端 | **herdr TUI + SSH** |
| 12 家 harness 启动器 | **herdr**（`agent start --kind`，21 家） |
| agent 状态观测 | **herdr**——含 `blocked` 检测与 pane→tab→workspace 的状态 rollup |
| claude native 桥接 18,090 行 | **不需要**（见下） |
| polly：跨 harness 编排 | **herdgent 要建**——本项目的心脏 |
| chat.db 会话树 + FTS | 轻量 registry，只留编排树 |
| contextual policies（25 条） | **不做**——每会话可选 YOLO，其余用 harness 自己的权限机制 |
| omnibox 沙箱 / 凭证注入 | **不做**——跟着 YOLO 的决定走 |
| 成本统计与预算 | **不做**——native 走订阅，statusline 已在每个会话里显示 |
| 多用户 / SSO / 多租户 | **不做**——单人工具 |
| 定时任务 | 延后 |

## 两个决定性的取舍

**一、走 native，不走 SDK。** omnigent 两套都有：`claude-sdk` 3,324 行，`claude-native` 18,090 行。native 贵 5.4 倍，但它跑的是你平时用的那个 Claude Code——skills、hooks、settings、CLAUDE.md、权限模式、订阅额度全部照旧，上游升级零成本，而且人能接管。herdr 的本体就是真终端，走 SDK 等于把 herdr 换掉。

而 omnigent 那 18k 行 herdgent 几乎不用付：其中 `claude_native_forwarder.py` 5,382 行是把终端重建成 web UI 的消息流，`claude_native_bridge.py` 5,301 行大半是把 web 输入变回终端按键——**herdgent 两样都不需要，因为用户看的和打字的就是真 TUI**。剩下的状态检测 herdr 用 101 行 sh 解决了。

**二、代价是拿不到请求级控制。** 走 native 就意味着不在 LLM 请求路径上：模型路由、出站 PII 扫描、花费硬拦截都做不了。要那些能力只能走 SDK，而走 SDK 就是重做一个 omnigent。这个边界是干净的，没有中间态。

## 编排的物理布局

herdr 的模型跟编排结构天然对齐——worktree 就是带 git provenance 的 workspace，且自动与父 repo workspace 分组：

```
Space 侧栏
└─ myrepo                    orchestrator 待在这里（不写代码，不需要 worktree）
   ├─ auth-refactor          worker：worktree workspace + claude
   ├─ fix-sse-error          worker：worktree workspace + codex
   └─ review-auth-refactor   worker：评审，pi
```

状态 rollup 是 herdr 自带的：一个 worker `blocked`，它的 pane、tab、workspace 全部显示 blocked。**跨会话总览因此不用建**——Space 侧栏看整体，Agent 侧栏看每个 worker，会话内部看 statusline。

## 怎么用

**装一次，之后每个会话都能派活**：

```sh
npm run install-local           # 同步到 ~/.herdgent 并注册 MCP + herdr 插件
node bin/install.mjs --dry-run  # 先看它要做什么
node bin/install.mjs --print    # 只打印命令，自己去跑
```

**所有东西都在 `~/.herdgent`**：

```
~/.herdgent/
├── bin/ lib/ skills/       代码 + 两份 playbook       ← install 会覆盖
├── herdr-plugin.toml
├── INSTALLED.json          装的是哪个 commit、当时工作区脏不脏
├── config/                 ← install 绝不动
│   ├── profiles.json       自定义 worker profile（键名与内置同名即覆盖）
│   ├── presets.json        自定义编排预设
│   ├── modes.json          自定义编排模式（内置 rex / fox）
│   └── workflows/*.md      自定义编排工作流（prompt 形式）
└── state/                  registry.json、各会话的 settings、日志
```

与开发工作副本分开：MCP 配置里存的是绝对路径，指向工作副本的话改一行代码就立刻
影响所有正在用的会话——隔一个显式的 install 步骤，改动什么时候生效由人决定。
**已经开着的会话不会加载新版本**，新开会话才生效。

> herdr 会另外建两个**空目录**并在 `plugin list` 里显示：
> `~/.local/state/herdr/plugins/herdgent` 与 `~/.config/herdr/plugins/config/herdgent`。
> 那是它启动插件命令前的固定动作（要注入 `HERDR_PLUGIN_STATE_DIR`），删了下次调用还会回来。
> **herdgent 不读也不写那里**——所有落盘都在 `~/.herdgent`。

装完就是这个流程：**在你已经聊清楚需求的那个会话里**，直接打 `/rex` 或 `/fox`：

```
/rex 把认证模块的 token 刷新逻辑重构了，验收标准是现有测试全绿
/fox 调研一下我们有几种缓存实现，各自用在哪
```

`/rex` 走开发编排（worktree + 分支 + 换厂商评审），`/fox` 走只读研究（当前 space 加 tab）。
也可以不用命令，直接说「用 herdgent 并行做这几件事」。

两条命令在 **claude / codex / pi 三家都能用**：三家的 skill 格式是一样的
（frontmatter + markdown），只是目录不同。install 用**唯一真源 + 软链**——
真源是 `~/.herdgent/skills`，往各 harness 的 skills 目录建软链而不是拷贝，
拷贝会变成几份各自漂移的副本。只装到**已经存在**的 harness 目录，也不碰
用户自己放在那里的同名 skill。

**需求的上下文就在当前会话里**，不用另起一个空白的编排者会话重讲一遍。

编排者**在不在 herdr 里都行**。CLI 直连一个 agent、只要结果不看过程，同样能派活：
herdgent 只需要能连上 herdr socket，而 **worker 永远跑在 herdr 的真终端里**，
随时能点进去看、能直接打字接管。

### 另一条路：起一个干净的编排者会话

不想污染当前会话时（比如一批互不相关的任务），用 plugin action。
herdr **没有命令面板**，action 只能经 CLI、快捷键或 Ctrl+click 匹配的 URL 触发：

```sh
# 在目标仓库的 workspace 里跑；当前活跃 workspace 决定编排哪个仓库
herdr plugin action invoke orchestrate --plugin herdgent
```

想绑快捷键就自己往 `~/.config/herdr/config.toml` 加——那是用户配置，插件不代写：

```toml
[[keys.command]]
key = "prefix+alt+o"
type = "plugin_action"
command = "herdgent.orchestrate"
description = "start herdgent orchestrator"
```

### 两种编排：rex 与 fox

| | 容器 | 用在哪 |
|---|---|---|
| **rex** | 自己的 git worktree workspace + 独立分支 | **任何会写代码的活**。侧栏显示 `rex · <任务名>` |
| **fox** | 不新建 space，在当前 workspace 加 tab | **只读研究**。tab 显示 `fox · <题目> · <环节>` |

一次编排就是一个容器：**环节是 tab，环节内并行的 worker 是 pane**。
tab 名带状态后缀（`⋯` 跑着 / `✓` 完成 / `⚠` 有人卡住 / `✗` 失败），扫一眼侧栏就知道进度。

两种模式各有一份 playbook（`skills/rex/`、`skills/fox/`），编排者用
`orchestration_guide(mode: "rex")` 读。用户可在 `config/modes.json` 覆盖或新增自己的模式。

### 编排预设

**预设是一整套编排写成的数据**：谁实现、谁评审、谁的产物喂给谁。
`run_preset` 按它派活、等完成、把 diff 或上一步的回复传给下一步。

```
list_presets                        看有哪些
run_preset(preset, inputs)          跑
```

内置 `impl-and-review`（rex：实现 → 换厂商评审）和 `fanout-review`（fox：三家同时评审同一份 diff）。
预设声明自己属于哪个 mode，容器形态就跟着定了——**开不开 worktree 是模板的一部分，不是每次现想的**。
用户可在 `config/presets.json` 覆盖或新增。

**执行引擎刻意是哑的**：它只认识「派活、等完成、取产物、塞进下一步」四个动作，
不知道「评审」是什么意思、也不知道为什么 reviewer 要换厂商——那些语义全在预设数据里。
换个预设它就干完全不同的事。这是 [`AGENTS.md`](AGENTS.md) 那条编排层边界的落法：
语义从 prompt 挪进了结构化配置，但仍然没进代码。

取产物只有两个动作，都是机械的：`diff_of:<step>`（那步分支相对 base 的 diff）
和 `result_of:<step>`（那步 worker 的最后回复）。

### 自定义工作流

`config/workflows/<name>.md` 每个文件就是一份工作流，编排者用
`orchestration_guide(workflow: "<name>")` 读它；不带参数调用则返回内置 playbook
并列出有哪些自定义工作流可选。

工作流是 **prompt 不是代码**——写「谁评审谁、什么算验收、失败了怎么办」，
而不是写怎么调工具（那些在工具描述里）。这正是 [`AGENTS.md`](AGENTS.md)
那条「编排语义不进代码」的落点：语义可以由用户随时改写，不需要动 herdgent 一行。

### worker 不会递归

全局注册之后 worker 也会加载这些工具。herdgent 的 MCP server 启动时会**认出自己是不是 worker**
（查 registry 比对 `HERDR_PANE_ID`），是的话就不暴露 `spawn_worker` 那一组。
比整个屏蔽掉全局 MCP 温和——worker 仍能用你其它的 MCP 服务。

## 现状（0.7.0）

**跨厂商互审端到端跑通并实测**：`orchestrate` 起编排者 → 它派出 claude worker 在自己的 git worktree 里实现并提交 → 取出 diff → 派 **codex** worker 独立评审 → 判定 PASS（逐条核对了验收标准）→ 主仓库零污染。

这是 herdgent 存在的理由：单家编排 Claude Code 自己的 dynamic workflow 就够了。

| | |
|---|---|
| `bin/orchestrate.mjs` | 起 orchestrator 会话并注入编排工具（plugin action） |
| `bin/mcp-server.mjs` | 编排工具通道，orchestrator 的 stdio 子进程 |
| `bin/session-start.mjs` | 起一个独立的受管会话（plugin action） |
| `bin/reconcile.mjs` | `[[startup]]` 对账 |
| `bin/hook-claude.mjs` | Claude Code SessionStart 钩子 |
| `lib/worker.mjs` | worker 生命周期：起、命名、隔离、回收 |
| `lib/events.mjs` | herdr 事件订阅（长连接推送） |
| `lib/mcp.mjs` | 零依赖 stdio JSON-RPC |
| `lib/harness/` | claude / codex / pi 三家的适配：启动参数、提交语义、transcript 定位与解析 |
| `lib/profiles.mjs` | worker profile：把 harness + 模型 + 权限标志打包成一个名字 |
| `lib/presets.mjs` | 编排预设：把一整套多 worker 序列写成数据 |
| `lib/paths.mjs` | 所有落盘位置的唯一解析处——三条启动路径必须落到同一处 |
| `bin/install.mjs` | 同步到 `~/.herdgent` 并注册 MCP + herdr 插件 |
| `lib/modes.mjs` | 编排模式：rex（开发／worktree）与 fox（研究／tab） |
| `skills/rex/`、`skills/fox/` | 两种编排各自的 playbook——**全部语义在这里**，prompt 不是代码 |

### 十四个动词

`spawn_worker` · `wait_for_worker` · `read_worker` · `send_to_worker` · `cancel_worker` · `list_workers`
`set_worker_limit` · `list_profiles` · `orchestration_guide` · `herdr_status` · `ping`
`list_presets` · `run_preset` · `run_plan`

派活只能用 **profile**（`impl-gpt` / `impl-kimi` / `impl-sonnet` / `review-opus` / `review-gpt` /
`review-kimi` / `explore-deepseek`），harness、模型、思考等级都不能按次覆盖。
**评审换一家厂商**是编排 skill 的硬规则，profile 让它变成选一个名字的事。

两条硬约束定住了这张表：

1. **Claude 模型做 agent 只能走原生通道。** 网关（quota-proxy）代理的 Claude 只适合简单调用，
   不能拿来跑 agent。所以 `impl-sonnet` / `review-opus` 都是原生 Claude Code，经 pi 的
   profile 里不会出现任何 Claude 模型——有测试守着。
2. **Claude 订阅是最金贵的池子**，优先留给评审与需求分析／设计（后者是编排者自己在干）。
   所以实现主力是 `impl-gpt`（ChatGPT 订阅）和 `impl-kimi`（网关），`impl-sonnet` 只是
   **fallback**：前两个都不可用时才派。这是调度语义，写在 skill 里，引擎不认识它。

herdgent **不维护模型清单**——本地任何一份都会骗人（实测同一时刻 pi 的静态目录、
网关活目录、`--list-models` 输出、网关白名单四者互不一致）。profile 里的模型名原样透传，
由网关裁决，失败时如实报因。

它们**没有一个认识「评审」「实现」「互审」是什么意思**——`purpose` 对代码只是个字符串。
谁评审谁、评审不过怎么办，全在 skill 里。这是 [`AGENTS.md`](AGENTS.md) 那条边界的实际检验。

### 三家 harness

| | 能指定模型 | 提交语义 | session 引用 | 特别之处 |
|---|---|---|---|---|
| `claude` | ❌ 只跑自家 | 须补 enter | 自装钩子 | |
| `codex` | ❌ 只跑自家 | 自动提交 | herdr 报 id | 目录信任必须注入 |
| `pi` | ✅ **18 个模型** | 自动提交 | herdr 报 **path** | 只读用工具白名单，比 YOLO 精确 |

pi 的模型经 quota-proxy 覆盖 Anthropic / OpenAI / Google / Moonshot / 阿里 / 智谱 / DeepSeek 七家——
真正的跨厂商评审靠它。

## 为什么需要对账（一个具体例子）

herdr server 重启后只恢复布局、不恢复运行时：agent 进程全被杀，但 `agent list` 仍然报它们 `idle` + `interactive_ready: true`，而同一个 pane 在 `pane read` 下是 `pane_not_found`。**只看 agent 接口的编排器会对着尸体发指令。** `[[startup]]` 对账就是为此存在——实测能正确判死。

细节见 [docs/findings-2026-07-31.md](docs/findings-2026-07-31.md)。

## 许可

Apache-2.0。与 herdr（AGPL-3.0-or-later）经 CLI/socket 交互，不链接其代码。
