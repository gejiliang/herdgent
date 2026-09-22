# 编排底座常设化（2026-09-21）

## 起因：GG 报的两个工作流问题

1. 启用 rex 时期望「在 herdr 里已开着的 space 创建 worktree」，实际却是重新打开一个
   同目录的 space，再在里面创建 worktree。
2. 工作流跑完、验收之后，run 开启的 space / worktree 没有自动收尾。

## 现状核查（default session，herdr 0.9.1）

- 侧栏实证：GG 的 `w3W "GTerminal"`（全部 pane 的 cwd = **对象根**
  `~/GBase/workspaces/Trade/GTerminal`）之外，还有 herdgent 建的 `w46 "GTerminal"`
  （cwd = `repos/GTerminal`），活的 rex run `run-mubd2xalma9`（LSR）的 worktree `w47`
  挂在 w46 下——同一项目两组 space，正是问题 1 的现场。
- 台账实证：近期 accepted 的 run（如 run-mu6qzgstxpb）cleanup 全 done——**worktree
  容器与分支都被正确收掉了**。真正留下来的是基础 workspace 空壳：
  - run-mu6cccqt7l9 自建的 w4A 在 finalize 时 kept（pane cwd 从 repos/GTerminal 变成
    对象根——人动过，fail-closed 正确但壳留下了）；
  - 壳随后被 run-mu6qzgstxpb 当「pre-existing primary」领养（skipped 不关）；
  - 再之后 LSR 自建 w46——壳链：自建 → kept → 领养 → 再自建。
- 所以问题 2 的「没收尾」= **基础 workspace 空壳**，根因与问题 1 相同：
  herdgent 不该每 run 纠结一个临时壳，壳应该是常设的。

## herdr 硬约束（0.9.1 隔离 session hg-probe 实测）

| 实测 | 结果 |
|---|---|
| `worktree create --workspace <对象根ws>`（root pane cwd 非 git repo） | `not_git_worktree` |
| 同 workspace 加一个 cwd=repo 的 pane 后重试 | 仍 `not_git_worktree`——**只看 root pane 的 cwd** |
| `worktree create --workspace <id> --cwd <repo>` 同给 | 互斥：`[--workspace ID \| --cwd PATH]` |
| `workspace create --cwd <repo>` 建的 host，随后 `worktree create --workspace host` | 成功；host 获 provenance 成 primary，之后 `worktree list` 报 `source_workspace_id=host` |

结论：**「挂在人已开着的 space 下」只在那个 space 的 root pane 坐在 git repo 里时才可行**。
GG 的 space 开在对象根（非 repo），herdr 层永远当不了 source——字面设想不可行。
（cwd == repo 的已开 space 则天然被复用：integration-real-worker 实测 run 直接领养
host 当底座，不多建。）

## 决策：基础 workspace = 常设编排底座

推翻 issue #13 的「自建 + 未被使用则关闭」（那套判据的终点就是上面的壳链）：

- 无 primary 时 herdgent 显式建底座，label = **`<repo名> · runs`**——与人的同目录
  space 一眼区分（旧壳与 herdr 隐式创建都叫仓库名，混在一起正是问题 1 的观感来源）。
- 后续 run 经 herdr 的 primary 机制领养复用（`worktree list` 的
  `source_workspace_id`），一个 repo 一个底座。
- **finalize / reclaimSession / 启动失败回收，任何路径都不再关底座**；
  finalize 的 close_base_workspace 步骤只剩一行 skipped 记录（可观测性保留）。
- 人嫌碍眼可手动关；下个 run 经「无 primary → 自建」自愈。
- 台账的 base_workspace 字段保留（created_by_run / label / expected_cwd / evidence），
  纯证据，不再驱动任何关闭。

效果：GG 的两条抱怨一起消失——run 来了挂在底座下（不每 run 新开 space），run 走了
worktree 容器与分支收干净（finalize 既有行为），底座一个常设、名义清晰。

## 改动面

- `lib/worker.mjs`：resolveBaseWorkspace 重写（新 label、新 evidence、新注释）；
  删除 closeBaseWorkspaceIfUnused 与 settleFreshBaseShell；createOrchestrationSpace /
  startManagedSession / reclaimSession 的失败回收不再碰底座。
- `lib/finalize.mjs`：closeRunBaseWorkspace → noteRunBaseWorkspace（只写 skipped）。
- 测试：base-workspace.mjs / finalize-run.mjs / run-lifecycle.mjs / stage-root-pane.mjs /
  base-workspace-contract.mjs 全部按新语义改写；契约测试新增两条 source 约束抽验
  （not_git_worktree、--workspace|--cwd 互斥）。

## 验证（全部通过）

- `npm test`（mock，366 断言 ×3 轮）全绿。
- `node test/base-workspace-contract.mjs`（真 herdr 0.9.1 隔离 session）全绿。
- `node test/integration-real-worker.mjs`（真 herdr + 真模型，新回归）全绿：
  rex（impl-kimi 真干活 22-30s）→ finalize 未合并拒收 → merge 后重调 done →
  容器/分支收掉、底座 skipped 留着；fox（explore-deepseek）→ finalize 收 tab 不动宿主。
- 环境限制：本机 claude 默认 bypassPermissions，弹不出审批框，**blocked 应答路径
  无法真实回归**——由 0.9.0 时代的契约处理与单测守住。

## 遗留

- 旧壳 w46（label "GTerminal"，LSR run 的底座，created_by_run=true 记在它的台账里）：
  LSR finalize 时若跑的是旧代码会按旧判据尝试关闭（未被使用则关掉，无妨）；若 GG 动过
  则 kept 留下——之后会被当 primary 领养继续当底座，只是 label 不带 · runs。
  嫌乱可手动关，下个 run 自建新底座。
- integration-mcp.mjs / integration-crossharness.mjs（旧裸 spawn 契约）已于 2026-09-22 删除，
  由 integration-real-worker.mjs（rex/fox 全链路）与 integration-verbs.mjs（动词与中断复用、
  并发闸、claude 通道）接替。
