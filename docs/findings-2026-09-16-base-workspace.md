# 基础 workspace 归属与回收（issue #13，herdr 0.9.0 实测，2026-09-16）

环境：herdr 0.9.0（homebrew）、隔离 session `hg-i13-probe` / `hg-i13-contract-*`
（AGENTS.md 配方，env 擦净、唯一命名、用完 stop+delete），临时 git 仓库，无真实模型。
逐条契约经 `test/base-workspace-contract.mjs` 固化，换 herdr 版本后先跑它再信下表。

## 问题

一次 `herdr worktree create --cwd <repo>` 在 repo 还没有已打开的 primary workspace 时
**隐式多建一个基础 workspace**（label=仓库名，一个空 shell），worktree workspace 挂在它
下面成一组。run 只登记了后者，finalize 漏前者——每次 rex 编排在侧栏留一个空壳
（2026-09-15T15:49:30Z / 2026-09-16T00:36:13Z 服务器日志两例，w3N/w3S）。

## 实测契约（0.9.0）

| # | 契约 | 证据 |
|---|---|---|
| 1 | `worktree create --cwd <repo>` 无 primary 时隐式建 base + 子；已有 primary 时复用 | 空 session 里第一次调用后 `workspace list` 多出 base `w1`(label=repo名, `is_linked_worktree:false`) 与子 `w2`；第二次调用只多子 |
| 2 | `worktree list --cwd <repo>` → `result.source.source_workspace_id` 给出当前 primary；**没有时该字段缺失**（不是 null） | 无 primary：`{"source":{"repo_root":…}}`；有 primary：多出 `"source_workspace_id":"w1"` |
| 3 | `worktree create --workspace <id>` 用显式 source，**不再隐式创建**；显式 `workspace create --cwd <repo>` 建出来的被用作 source 后即获得 worktree provenance、成为 group primary | `workspace create` → `w5`；`worktree create --workspace w5` → 子 `w6`，无新 base；`w5` 获得 `is_linked_worktree:false` provenance |
| 4 | group 守卫按 primary 计：`workspace close <primary>` 在它还有 linked 子时被拒 `workspace_group_close_required`；子收掉后可关。CLI 无 `--group`，只有 API 有 `close_group` | 关有子的 w1/w5/w8 均被拒；remove 子后关 w5/w8 返回 `{"type":"ok"}` |
| 5 | 同一 repo 可有两个显式 primary；`worktree list` 指认其中一个（先建的），另一个用作 source 后同样成 primary，守卫各自独立 | w7/w8 同 repo，`--workspace w8` 建子 w9；关 w8 被拒、关无子的 w7 直接成功 |
| 6 | 「未被使用」的可观测面：base 是 1 tab / 1 pane、`agent_status:"unknown"`、`pane list` 的 `foreground_cwd`==建时 cwd、`pane process-info` 前台就是 shell（`shell_pid`==fg pid，name 是 zsh/bash/…）；`agent get <pane>` → `agent_not_found` | probe 输出见会话日志；判据已固化在 `closeBaseWorkspaceIfUnused` |

注意路径解析：herdr 返回的 `root_pane.cwd` / `foreground_cwd` 是**解析过的**真实路径
（macOS `/tmp`→`/private/tmp`），而 `worktree.checkout_path` 保留原样——比较 cwd 必须用
创建时响应里的 `root_pane.cwd` 做基准，两边同出一源。

## 设计（修复）

**归属证据只有两种，都落台账**（run 的 `base_workspace` / session 的 `base_workspace` /
结果日志 `state/runs/<run_id>.json`）：

- `created_by_run=true` —— `worktree list` 确认无 primary 后，`workspace create` 的
  **响应**把 id 交给了本次调用；附带 label 与 `expected_cwd`（`root_pane.cwd`）。
- `created_by_run=false` —— `source_workspace_id` 指认它先于本 run 存在：**领养，绝不关闭**。

绝不按 label 匹配、也不按「创建前后 workspace 集合差」认领——并发两个创建时，
差集会把别人的 base 算到自己头上。竞态（双方同时看到无 primary）的代价只是各建一个
空壳，各自只认自己响应里的 id，互不误删。

**关闭判据（`closeBaseWorkspaceIfUnused`，fail closed）**——仅当 `created_by_run=true`
且全部结构判据通过才关：1 tab/1 pane、label 未改、workspace/pane `agent_status` 均
`unknown`、唯一 pane 的 `foreground_cwd`==`expected_cwd`、前台进程是 shell 提示符。
任一不满足或读不出来 → kept（刻意保留，**不是失败**，step 里写明原因）；herdr 不可达
→ aborted（可重试）；最后还有 herdr 的 group 守卫兜底——并发 run 的子还挂着时
`workspace close` 被拒，记 kept。

**接线点**：`createOrchestrationSpace`（rex run）与 `startManagedSession`（standalone）
都先 `resolveBaseWorkspace` 再以 `--workspace` 显式创建；worktree create 失败当场回收
自建的 base；`startManagedSession` 启动失败的 reclaim 与 `reclaimSession` 同样只收
「本次创建且未被使用」的 base。`finalize_run` 的 worktree 清理在删分支后追加
`close_base_workspace` 一步：skipped（无登记=旧 run / 领养）与 kept 不影响结论，
failed 进 partial 可幂等重试。

## 测试

- `test/base-workspace.mjs`（假 herdr，进 npm test）：standalone 正常回收、启动失败
  收自建 base 不留壳、启动失败不动预存在 base。
- `test/run-lifecycle.mjs` / `test/finalize-run.mjs`（假 herdr，进 npm test）：显式
  source、归属登记、共享 base 被 group 守卫保留、独占 base 随 finalize 关闭、预存在
  base skipped、被「用户」改动 kept、结果日志带证据。
- `test/base-workspace-contract.mjs`（真 herdr 隔离 session，独立运行，无模型）：
  契约抽验 6 条 + rex 正常 / 预存在保留 / 用户变更保留 / 双 run 共享不误删四个场景，
  自清 session、workspace、worktree、分支。
