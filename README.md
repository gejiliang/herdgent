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

## 现状（0.0.1）

最小闭环已实测跑通：起受管会话 → SessionStart 钩子回填 harness session id → 重启后对账埋葬幽灵。
manifest 已经过 herdr 0.7.5 校验器实测，`[[startup]]` 与两个 action 均验证被真的调用。

- `bin/session-start.mjs` — 起一个受管会话（plugin action）
- `bin/reconcile.mjs` — `[[startup]]` 对账
- `bin/session-list.mjs` — 列出受管会话
- `bin/hook-claude.mjs` — Claude Code SessionStart 钩子

编排层尚未开始。

## 为什么需要对账（一个具体例子）

herdr server 重启后只恢复布局、不恢复运行时：agent 进程全被杀，但 `agent list` 仍然报它们 `idle` + `interactive_ready: true`，而同一个 pane 在 `pane read` 下是 `pane_not_found`。**只看 agent 接口的编排器会对着尸体发指令。** `[[startup]]` 对账就是为此存在——实测能正确判死。

细节见 [docs/findings-2026-07-31.md](docs/findings-2026-07-31.md)。

## 许可

Apache-2.0。与 herdr（AGPL-3.0-or-later）经 CLI/socket 交互，不链接其代码。
