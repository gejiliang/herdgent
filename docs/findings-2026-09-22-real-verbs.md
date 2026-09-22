# 真实动词回归的四个发现（2026-09-22）

`test/integration-verbs.mjs`（真 herdr + 真模型，替代旧 integration-mcp / crossharness）
建/调过程中实测到的四个事实，按影响排序。

## 1. Claude 订阅访问被组织禁用（账号层，待 GG 裁决）

- 现象：任何路径起 claude（herdr agent、隔离 session、本机正常环境 `claude -p`）
  都报 **"Your organization has disabled Claude subscription access for Claude Code ·
  Use an Anthropic API key instead"**；TUI 状态栏同时显示 "5H: [Rate limited]"。
- 影响：profile 表的 **impl-sonnet 与 review-opus 当前都不可用**（Claude 做 agent
  只能走原生通道，网关代理不能顶替——硬约束 1）。实现主力剩 impl-kimi（+fallback
  impl-glm）；S+ 评审空缺（review-kimi/deepseek 都不是 S+）。
- 待 GG：续订/换 API key/确认是临时风控还是终止。profiles.mjs 的表未动——
  凭据是配置，订阅回来一行不用改。
- integration-verbs 的 claude 段已写成【自动降级】：订阅禁用期验机械链路
  （信任框应答/启动/hook/transcript/read），恢复后 PASS 硬断言自动回升。

## 2. claude 信任框默认高亮是 "No, exit"（实操知识）

非 yolo 的 claude 在没信任过的目录（每个 worktree 都是新目录）首启弹
「Quick safety check」信任框，**默认高亮 `No, exit`**，`Yes, I trust this folder`
在第二项。只按 enter 会选 No 直接退出——应答必须 `send-keys down` 再 `enter`
（0.9.1 隔离 session 实测序列）。选项框一律走 keys 的既有结论之上再加一条：
**先看高亮落哪**。

## 3. wait 层对 blocked 不敏感（已修）

旧 settledNow 把 blocked 当普通终态过 turns 判据——blocked 的 worker 在等人应答，
永远不会有新产出，于是 wait/run_plan 挂到 30 分钟兜底上限。实测：非 yolo claude
的信任框把 run_plan 挂了 30 分钟。
修复：blocked 直接落定（不等 turns），registry 写回 agent_status=blocked，
编排者收 waitFailureReason 的指引（read screen → send keys → 再等）。
test/wait-blocked.mjs：blocked worker 1.4s 落定（修复前 30 分钟）。

## 4. pi 被 Esc 中断后有恢复窗口

`cancel_worker mode=interrupt`（Esc）后 pi 不立刻回可输入状态：紧接着
`send_to_worker` 会在确认窗口内观察不到提交（`submitted:false, seq 6→6`），
但指令稍后仍被消化。herdgent 如实返回 submitted:false——**编排者该等回稳再派、
false 就重发**（integration-verbs 实测：轮询 agent_status 回 idle/done 后一发即中，
seq_before 从 6 变 7 说明重发前的等待里状态也推进过）。
