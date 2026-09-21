# herdr preview 2026-09-21 影响评估（2026-09-21）

## 结论与证据边界

- 触发：GG 报「herdr 更新了」。本机 CLI 与运行中 server 均为 stable **0.9.1**（protocol 22，
  endpoint compatible）；上游 2026-09-20 21:50Z 发布 **preview-2026-09-21-0ff0f27e2226**，
  stable 通道仍停在 0.9.1。本评估针对 `v0.9.1...0ff0f27e2` 的 **34 个 commit**（即未来 0.9.2 的 delta）。
- preview 构建**未在本机安装**；未起 worker、未重启服务、未改运行时代码。结论来自上游源码/文档
  diff 与本地调用点对照，非实测。
- 结论：三条修复直接命中 herdgent 的等待、回收与对账路径，全部向好，**无需紧急适配**；
  建议留在 stable 等 0.9.2，升级后补跑契约测试与真实 worker 回归。

## 直接相关

### 1. #4225 事件订阅 drain + 显式 events_lost（src/api/subscriptions.rs、server.rs）

- **0.9.1 现状**：共享事件历史只留 512 条，每条订阅每 100ms 至多发出 1 个匹配事件；突发积压
  时游标被挤出保留窗，**静默**从最旧保留处继续，丢事件无任何信号。官方对照实测 600 事件
  只收到 516 个。
- **preview**：每轮 drain 整个保留批次（对照 600/600，约 0.97s）；订阅者落后出保留窗（含
  订阅初始化窗口）时，服务器发带原请求 id 的 `error.code:"events_lost"` 并**关闭该条订阅
  连接**，不再静默跳过。官方恢复建议：重订阅 + 另一连接取 session.snapshot 对账。
- **herdgent 调用点**：`lib/events.mjs watchEvents`（一 pane 一连接订阅
  pane.agent_status_changed）与 `bin/mcp-server.mjs wait_for_worker`。
  - 兼容性：events_lost 错误行没有 `msg.event`，被忽略；随后 socket close 触发 `onClose`
    → worker 记入 `unreachable(event_stream_closed)`；全部不可达时 wait 立即返回。
    **从「静默挂到 30 分钟上限（WAIT_CEILING_MS）」变成「快速显式失败」**，不崩、不用改。
  - herdgent 的「订阅后 onReady 补查 settledNow」与官方「重订阅+取快照」恢复模式同构。
  - 可选改进（未做）：watchEvents 认出 events_lost 行后自动重订阅+补查，把 unreachable
    变成自愈。

### 2. #4301 worktree 归属误判修复（issue #4293，src/app/api/worktrees.rs）

- **0.9.1 隐患**：repo 基础 workspace 首 tab 的 shell cwd 落进某个 linked worktree 时，
  herdr 把基础 workspace 当成该 worktree 的（`worktree list` 的 open_workspace_id 指错、
  `worktree open` 返回 already_open 并翻转 is_linked_worktree）；此时 `worktree remove`
  会**删掉 checkout 并关闭基础 workspace**，连带杀掉里面所有 pane（上游 issue 实测复现，
  0.9.0/0.9.1 均中招）。
- **herdgent 暴露面**：`finalize_run` 对 run 容器做 `worktree remove`（lib/finalize.mjs、
  lib/worker.mjs）；编排者所在的基础 workspace 若被人把首 pane cd 进 run 的 worktree，就处
  在该 bug 作用域内。`closeBaseWorkspaceIfUnused` 的 foreground_cwd==expected_cwd 守卫
  能挡住「自己关错 base」，挡不住归属翻转后的连锁与人在 picker 里的手动删除。
- **preview 修复**（"preserve explicit worktree workspace membership"）：显式成员关系不再被
  cwd 推断翻转。升级后按 docs/findings-2026-09-16-base-workspace.md 的规矩先重跑
  `test/base-workspace-contract.mjs` 再信契约表。

### 3. #4400 session 布局保留（src/persist/*，schema 新增 restore_error）

- 恢复失败（保存的目录不可用 / shell 起不来）的 pane **留在布局里显示错误**，不再消失或挪到
  home；保存的目录与 agent session 引用保留，修好后重启 server 可重试。`session.json` 读不了
  时先把原字节存进 `session-backups/` 再覆盖；`session-snapshots/` 保留至多 48 份布局快照
  （15 分钟节流，可手动恢复）。API schema 新增 `restore_error` 字段（additive）。
- **herdgent 调用点**：`bin/reconcile.mjs` 的判据是 `agent get` → `agent_not_found` 判死；
  恢复失败的 pane 没有 agent，结论不变，pane 是否留在布局里不影响对账。无需改；
  `restore_error` 是未来可用于更准对账的可观测增量。

### 4. #4353 socket 错误响应保留请求 id

- 0.9.1：invalid_request 与**订阅建立期**错误响应不带原请求 id（空串）；typed 校验后派发
  失败的普通请求不受影响。文档同时钉死：订阅数组里一个 pane 不存在就整流拒绝并关闭连接
  （与 lib/events.mjs 文件头实测约束第 2 条一致）。
- herdgent：`requestOnce` 按 id 匹配但只用于 agent.read 等派发后失败的路径（0.9.1 已带 id）；
  `watchEvents` 把首行当 ack 不看 id，订阅被拒时首行即错误，已正确处理。**中性偏正，
  无适配**。

### 5. #4383 新增 pane.clear API 与 keys.clear_pane

- 纯增量。spawn_worker 复用预建 pane（未动过的 shell 才复用）的路径将来可在复用前调
  `pane.clear` 清屏清 scrollback，非必需。

## 弱相关 / 无关

| 上游变化 | 判断 |
|---|---|
| #4196 codex 自定义中断键的状态检测 | profiles 表当前无 codex（ChatGPT 凭据未归，见 lib/profiles.mjs 文件头）；lib/harness/codex.mjs 保留，凭据回来时直接受益 |
| #4250 opencode tui.json、#4337 grok、#4372 kiro 检测 | herdgent 无对应 harness |
| #4340 ssh 压缩、#4256 机器元数据缓存、--machine 系列 | herdgent 仍本机语义（lib/events.mjs 裸连本机 socket；registry/git/fs 本机）；延续 091 结论，不扩张远程编排 |
| Windows VT/鼠标/pwsh 一串修复 | herdr-plugin.toml platforms=["macos"]，无关 |
| #4384 go to picker、#4355 侧栏、#4409 关末 tab 确认、#4404/#4389 光标、#4247 鼠标上报 | 人走 TUI 的体验，与编排无关 |
| #4395 无终端 attach 在开 session 前拒绝 | herdgent 不 attach；人手动操作时更早报错 |

## 后续建议（未执行）

1. 留在 stable；0.9.2 stable 发布后再升级（herdgent 只跟 stable 语义，preview 未装本机）。
2. 升级当天：`npm test` → 隔离 session 跑 `test/base-workspace-contract.mjs`（换版本先跑契约
   是既定规矩）→ 补上 2026-09-17 评估欠下的真实 worker 隔离回归（start → prompt →
   working/blocked → read → finalize 重试）。
3. 一起还旧账：herdr-plugin.toml 的 min_herdr_version 与 bin/install.mjs 的 MIN_HERDR 仍是
   0.9.0；091 评估已建议「回归后抬到 0.9.1」未做，升级时直接抬到实际版本并更新 README。
4. 可选（单独立项）：watchEvents 识别 events_lost 自动重订阅+补查；复用 pane 前 pane.clear。

## 来源

- https://github.com/herdrdev/herdr/releases/tag/preview-2026-09-21-0ff0f27e2226
- https://github.com/herdrdev/herdr/compare/v0.9.1...0ff0f27e222633c97ba4291f6b9be4137002ca84
- issue #4293（worktree 归属误判复现）、PR #4225/#4301/#4353/#4383/#4400 的 commit diff
- 本地：lib/events.mjs、bin/mcp-server.mjs（wait_for_worker、WAIT_CEILING_MS=30min）、
  bin/reconcile.mjs、lib/finalize.mjs、docs/findings-2026-09-16-base-workspace.md
