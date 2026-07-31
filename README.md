# Herdgent

以 **herdr** 为底座与前端的 meta-harness——起、跟踪、编排受管 agent 会话。

一句话定位：**omnigent 的替代版，但把 omnigent 最重的两块换成 herdr。**

| omnigent 的东西 | herdgent |
|---|---|
| tmux 终端底座 | **herdr**（socket API） |
| 自有 web/CLI 客户端 | **herdr TUI** + herdroid（iOS） |
| 11 家 harness 启动器 | **herdr**（`agent start --kind`，21 家） |
| agent 状态观测 | **herdr**（14 家 integration） |
| transcript → web UI 转发（约 12k 行） | **不需要**——用户看的就是真 TUI |
| native bridge 控制面 | **herdgent 要建**（本项目的心脏） |
| 编排 / 会话索引 / 成本 | **herdgent 要建** |
| policies / sandbox / 多租户设施 | 砍 |

形态是 **herdr plugin + 外部进程**：不 fork herdr、不改 herdr 核心，因此可通过
`herdr plugin install` 分发。

## 现状（0.0.1）

最小闭环已跑通并实测：起受管会话 → 钩子回填 harness session id → 重启后对账埋葬幽灵。
manifest 已经过 herdr 0.7.5 校验器实测（`plugin link` 一次通过），`[[startup]]` 与两个
action 均验证被真的调用。

- `bin/session-start.mjs` — 起一个受管会话（plugin action）
- `bin/reconcile.mjs` — `[[startup]]` 对账
- `bin/session-list.mjs` — 列出受管会话
- `bin/hook-claude.mjs` — Claude Code SessionStart 钩子

控制面目前只做到 session id 回填。权限接管、提问劫持、MCP 反向通道、成本、编排尚未开始。

## 为什么需要它（一个具体例子）

herdr server 重启后只恢复布局、不恢复运行时：agent 进程全被杀，但
`agent list` 仍然报它们 `idle` + `interactive_ready: true`，而同一个 pane 在
`pane read` 下是 `pane_not_found`。**只看 agent 接口的编排器会对着尸体发指令。**
herdgent 的 `[[startup]]` 对账就是为此存在——实测能正确判死。

细节见 [docs/findings-2026-07-31.md](docs/findings-2026-07-31.md)。

## 许可

Apache-2.0。与 herdr（AGPL-3.0-or-later）经 CLI/socket 交互，不链接其代码。
