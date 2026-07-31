# v0.1 实施计划 — 跨 harness 编排

> 需求与设计结论见 [`README.md`](../README.md)；实测依据见 [`findings-2026-07-31.md`](findings-2026-07-31.md)。
> 六步，每步一个提交，每步都有**能跑起来的验收**——不以「文件写完了」算完成。

## 目标（v0.1 验收）

在 herdr 里 invoke `orchestrate` → 跟 orchestrator 说「这两件事并行做，做完互相 review」→
Space 侧栏出现两个 worktree workspace、名字是任务名不是 `claude` → 跑完 → orchestrator 拿到两份结果并组织出评审 →
全程可以点进任一 worker 直接打字接管。

**只支持 claude worker。** codex 留到 v0.2——那时才会知道抽象对不对。

## 步骤

### 1. registry 并发安全 + 编排树

`lib/registry.mjs`

- `withLock(fn)`：`mkdir` 原子锁 + 过期时间 + 重试。**必须有过期**，否则进程崩了锁不释放，全线卡死。
- `put` / `save` 的「读—改—写」全部移进锁内。现在多个 MCP server 会并发写，丢更新是必然。
- 新字段：`role`（orchestrator/worker）、`root`（编排 id）、`parent`、`title`、`purpose`、`worktree_branch`、`checkout_path`。
- `countLive({ root })`：返回单编排与全局的活 worker 数，给并发闸用。

**验收**：并发测试脚本起 20 个进程同时 `put`，最终 registry 恰好 20 条，无丢失。

### 2. 事件订阅 + MCP 骨架

`lib/events.mjs`、`lib/mcp.mjs`

- `events.mjs`：`net.connect(HERDR_SOCKET_PATH)` → 发 `events.subscribe` → 读 newline-delimited JSON。
  必须处理 herdr 重启导致的断线（重连或明确报错，不能静默死掉）。
- `mcp.mjs`：stdio JSON-RPC。`initialize`（回显客户端 `protocolVersion`）/ `tools/list` / `tools/call`，
  外加 **`notifications/progress`**——从 `params._meta.progressToken` 取 token（实测 Claude Code 会发），用于顶住 30 分钟 idle。
- 骨架先只挂一个 `ping` 工具。

**验收**：`claude --mcp-config <path> -p "call ping"` 返回预期字符串；断开 herdr server 后订阅端有明确错误而不是静默挂起。

### 3. spawn_worker + list_workers

`bin/mcp-server.mjs`、`lib/worker.mjs`

- 并发闸在锁内检查：**单编排 ≤ 6、全局 ≤ 12**，超了直接报错。写死，不做配置。
- 有 `branch` → `herdr worktree create`；无 → `workspace create`。
- `waitForShell` → `startAgentWhenReady`（初始 prompt 作为 argv，**必须带**，否则落在会话面板首页且 herdr 观测不到）。
- **登记先于 `agent start`**——SessionStart 钩子在 `agent start` 执行期间就回调，晚了 session id 就丢。
- `agent rename` 成任务名。注意 herdr 的名字约束：小写字母开头、只含 `[a-z0-9-_]`、1–32 字符，
  `title` 要做 slug 转换，不能直接用。

**验收**：**连起 6 个 worktree worker**，记录失败率与失败码。这是设计阶段留下的最后一条风险——
worktree 比普通 workspace 多一步 git checkout，可能更慢或有新失败模式。

### 4. wait_for_worker + read_worker

- `wait_for_worker`：先记 `state_change_seq`，再挂事件流，等到状态 ∈ {`done`,`idle`,`blocked`} **且 seq 变化**。
  不做去重会立刻拿到上一轮的终态。**不设 timeout 参数**——靠 progress 续命，一次等到底。
- `read_worker`：`mode=result` 读 transcript jsonl 的最后一条 assistant 消息（零约定，worker 不需要知道自己被编排）；
  `mode=screen` 读终端可见内容，诊断用。
- transcript 路径来自 SessionStart 钩子回填，spawn 后可能还没到，要能等。

**验收**：spawn → wait → read 完整闭环，拿到 worker 的实际回答。

### 5. send_to_worker + cancel_worker

- `send_to_worker`：`agent prompt` → `send-keys enter` → **验 `state_change_seq` 变化**。三步都不能省，
  已复验 `agent prompt` 不回车（官方文档说原子提交，实测不成立）。
- `cancel_worker(mode)`：
  - `interrupt` → `send-keys ctrl+c`，实测只中断当前轮，**worker 存活可复用**；
  - `terminate` → 关 workspace + `herdr worktree remove` + **`git branch -D`**（`worktree remove` 不删分支）。
- 分支删除只能删自己建的——按 registry 里记的 `worktree_branch` 删，绝不按模式匹配去扫。

**验收**：派活 → 中断 → 重新派活成功 → terminate → 目标仓库 `git branch` 与 `git worktree list` 均无残留。

### 6. orchestrate action + 编排 skill + 端到端

`bin/orchestrate.mjs`、`herdr-plugin.toml`、`skills/orchestrate/SKILL.md`

- 起 orchestrator 会话：建 workspace（在目标 repo，不建 worktree——它不写代码）→ 写 MCP config 到 state dir → 起 agent。
- ⚠️ **argv 顺序**：`--mcp-config` 是可变参数，会把紧随其后的位置参数当成第二个配置文件。
  初始 prompt 必须在所有 flag 之后，且与 `--mcp-config <path>` 之间隔着别的 flag 或 `--`。这个坑已经踩过一次。
- MCP server 启动时扫一遍 registry，标出 `parent` 已死的孤儿 worker。**不自动杀**——杀正在干活的 agent 不可逆，列出来问人。
- skill 是 prompt，不是代码。语义（谁实现谁评审、跨厂商配对规则）全部写在这里，**不进 herdgent 的代码**。

**验收**：见上方「目标」。

## 不做（v0.1 范围外）

codex 及其他 harness · 成本 · 权限策略 · 沙箱 · 总览 UI（herdr 的 rollup 已经给了）· 定时任务 · 会话全文索引

## 已知会撞的坑（都已实测，别重新发现）

| 坑 | 处理 |
|---|---|
| `agent prompt` 不回车 | 补 `send-keys enter` 并验 seq |
| `agent start` 报 `agent_pane_busy` | 按 herdr 的回答重试，别猜它的判据 |
| 起 agent 失败会漏下空 workspace | 必须回收 |
| SessionStart 钩子在 `agent start` 期间就回调 | 登记先于起 agent |
| `worktree remove` 不删分支 | 补 `git branch -D` |
| `--mcp-config` 吞掉后面的位置参数 | 初始 prompt 放最后 |
| **agent 参数不能含换行** | 压成单行，原文另存文件；编排任务必然多行，必踩 |
| 终态是 `done` 不是 `idle` | 等待条件包含 done |
| 被起的会话继承父进程环境 | 起 runtime 前擦 `CLAUDE_CODE_*` |
