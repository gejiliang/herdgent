# Herdgent — Claude Code 入口

@AGENTS.md

## 仅 Claude Code 适用

- 本项目的控制面钩子（`bin/hook-claude.mjs`）经 `--settings` 注入被管理的会话，**与用户自己的 `~/.claude/settings.json` 是合并语义**（实测，见 findings）。改钩子注入逻辑前先确认这条仍成立。
- 调试受管会话时注意：被起的 claude 会**继承起它那个进程的环境变量**。用干净 env 起 runtime，否则会把 `CLAUDE_CODE_*` 一路传进去（症状：状态栏出现「Transcript saving is off — inherited CLAUDE_CODE_…」、会话标题串台）。
