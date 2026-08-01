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

安装副本在 **`~/.herdgent`**，与开发工作副本分开。MCP 配置里存的是绝对路径，
指向工作副本的话改一行代码就立刻影响所有正在用的会话——隔一个显式的 install
步骤，改动什么时候生效由人决定。`~/.herdgent/INSTALLED.json` 记着装的是哪个 commit。

**已经开着的会话不会加载新版本**，新开会话才生效。

装完就是这个流程：**在你已经聊清楚需求的那个会话里**，直接说「用 herdgent 并行做这几件事」。
不用另起一个空白的编排者会话把需求重讲一遍——需求的上下文就在当前会话里。

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

### worker 不会递归

全局注册之后 worker 也会加载这些工具。herdgent 的 MCP server 启动时会**认出自己是不是 worker**
（查 registry 比对 `HERDR_PANE_ID`），是的话就不暴露 `spawn_worker` 那一组。
比整个屏蔽掉全局 MCP 温和——worker 仍能用你其它的 MCP 服务。

## 现状（0.4.0）

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
| `skills/orchestrate/SKILL.md` | **编排的全部语义**——prompt，不是代码 |

### 十个动词

`spawn_worker` · `list_workers` · `list_profiles` · `list_models` · `wait_for_worker` · `read_worker` · `send_to_worker` · `cancel_worker` · `set_worker_limit` · `ping`

派活用 **profile**（`claude-impl` / `review-gemini` / `explore-fast` …）而不是自己拼参数。
**评审换一家厂商**是编排 skill 的硬规则，profile 让它变成选一个名字的事。

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
