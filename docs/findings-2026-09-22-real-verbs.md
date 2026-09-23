# 真实动词回归的四个发现（2026-09-22）

`test/integration-verbs.mjs`（真 herdr + 真模型，替代旧 integration-mcp / crossharness）
建/调过程中实测到的四个事实，按影响排序。

## 1. Claude 订阅访问被组织禁用（账号层；GG 已裁决：harness 只用 pi）

- 现象：任何路径起 claude（herdr agent、隔离 session、本机正常环境 `claude -p`）
  都报 **"Your organization has disabled Claude subscription access for Claude Code ·
  Use an Anthropic API key instead"**；TUI 状态栏同时显示 "5H: [Rate limited]"。
- **GG 2026-09-22 裁决 Claude 不再使用、harness 只用 pi；2026-09-23 再定档位**：
  Astra（gpt-6-astra）只做评审、是唯一 S+（mid）；实现 impl-glm（GLM-5.3-flash）+
  impl-deepseek（DeepSeek-v4.1-flash，ark），fallback impl-deepseek-official（官方 API）；
  评审 S 档 review-kimi / review-glm；探索 explore-astra；DeepSeek v4 全系退役。
  （0922 的过渡排法 impl-kimi+impl-gpt / review-deepseek 补 S+ 仅一天即被取代。）
  埋 bug 小测：deepseek-v4-pro / gpt-6-astra / step-5-preview / ark-kimi-k3 都抓到
  核心缺陷，ark-glm-5.3 在 2500 tok 预算零产出。lib/harness/claude.mjs 保留。
- integration-verbs 的 claude 段改用测试自带的临时用户 profile（probe-claude），
  写成【自动降级】：订阅禁用期验机械链路，恢复后 PASS 硬断言自动回升。

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
