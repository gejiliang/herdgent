# 预建 stage root pane 的归属（issue #14，herdr 0.9.0 实测，2026-09-16）

环境：herdr 0.9.0（homebrew）、隔离 session `hg-i14-probe-*`（AGENTS.md 配方，
env 擦净、唯一命名、用完 stop+delete），无真实模型。与
findings-2026-09-16-base-workspace.md 同属一批收尾现场发现的问题。

## 问题

`run_plan` 把整个计划的 tab【一次建齐】，每个 tab 自带一个 root pane（空 shell）。
计划提前停止（impl 等待上限 / blocked / 起不来）时，没轮到的环节从没派过 worker。
随后人工 `spawn_worker(run_id, step_id=review)` 一味在原 root 旁 split 新 pane 并登记
worker——**原空 root pane 既不在 worker 登记也不在 stray_panes**，finalize 的归属扫描
把它误判成 foreign，拒清整个容器（issue 现场：核对句柄后手动关闭才 finalize done）。

## 实测契约（0.9.0 探针，本修复的判据依赖）

| # | 契约 | 用途 |
|---|---|---|
| 1 | `tab create` 响应的 `root_pane` 带 `cwd` / `foreground_cwd`（herdr 解析过的真实路径，新 tab 继承 workspace cwd） | 创建回执 `root_pane_cwd` 的来源；**不能**拿 run 的 `checkout_path` 当基准（那个没解析过） |
| 2 | `pane list` / `pane get` 的行即刻带 `agent_status`（无 agent 时 `"unknown"`）与 `foreground_cwd` | 「未被使用」现查的可观测面 |
| 3 | 无 agent 的 pane：`agent get <pane>` → `agent_not_found` | agent 附着的双重确认 |
| 4 | **新鲜 pane 的 `pane process-info` 前台短暂不是纯 shell**（zsh 启动期会带 `locale LC_CTYPE` 子进程） | 单发一拍会把「还没就绪」误判成「被人在用」——`provePaneUnused` 的 shell 判据必须 bounded 等一拍 |

## 设计（修复）

归属证据与现查分离，两条安全性质同时成立：

- **归属必须完整**：stage root 的创建回执（`stages[tab].root_pane_id` + `root_pane_cwd`）
  落在 run 记录里——它从第一秒就是本 run 的登记对象，不是陌生 pane。
- **登记不等于可删**：凡是没有 worker 行的 stage root，复用/收尾前一律现查
  `provePaneUnused`（无 agent、前台停在 shell 提示符、cwd 未被改动，fail closed）。
  被人用过的按外来处理（拒删留人），读不出来走 failed/aborted 老路。

**追加（spawn_worker）**：环节从没派过 worker 时优先【复用】可证实空闲的预建 root
（不 split）；证明不了就保守 split。复用的 root 起 agent 失败时不登记 stray——
它本来就是 stage 记录里的对象，stray 登记会让 finalize 跳过现查直接认 owned。

**收尾（finalize_run）**：worktree 与 tab（fox）两条清理路径的归属扫描里，
workerless 的 stage root 经现查未被使用才算 owned；其余外来 pane/tab 的拒删语义不变。

## 测试

- `test/stage-root-pane.mjs`（假 herdr，进 npm test）：未启动阶段→追加复用→finalize；
  root 被用户占用（前台进程 / 用户 agent）→ 保守 split + 拒删 + 用户离开后重试成功；
  用户新增 pane 仍拒删；fox 同链成立、workerless root 现查照收、宿主不动。
- `test/fake-herdr.mjs` 夹具按契约 #1/#4 补齐：`tab create` 形状、`process-info`
  可按 pane 注入前台进程。
- 真 herdr 回归：`test/base-workspace-contract.mjs`（隔离 session）在本改动后全绿。
