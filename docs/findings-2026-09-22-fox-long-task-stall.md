# fox 长任务派发翻车实录：argv 截断（2026-09-22 发现，2026-09-23 修复）

Her 侧一次真实 fox run（`run-mucket8p054`，「调研 Ploy.ai」，6 个并行 task 全走
`explore-deepseek`）失败过程中实测到的事实与后续修复。现场已提取完毕
（tab `w45:t5` 已关）；run 在 registry 里保持 failed、未 finalize。

## 1. 超长任务文本 → agent.start 180s 超时（根因已定位，已修）

- **事故形状**：step 第一个 task 任务体 1187 字节（CJK，恰好低于当时的
  `ARGV_TASK_LIMIT=1200`），加上 pi 前缀（flags + profile 提示词）408 字节，
  整条敲进 pane 的命令 1595 字节。实际被砍在第 1022 字节（砍进「哪」的
  UTF-8 序列，pane 里的 `?` 乱码就是它），单引号不闭合，zsh 永远等下去，
  pi 从未启动，`--timeout 180000` 烧满后 step 判 failed。其余 5 个 task
  未再 spawn。
- **根因（2026-09-23 定位）**：不是「herdr 输入管线卡死」，也不是「慢速
  逐字符输入撑爆超时」——是 **shell 未就绪窗口里的内核规范行缓冲**：
  herdr 的 `agent start` 在 pane 刚建、zsh 还没执行完 `.zshrc`（未启用
  zle、tty 还在规范模式）时就把命令敲进去；`waitForShell` 只查前台进程
  是不是 shell（`pane process-info`），等不到提示符真正画好，拦不住这个
  窗口。规范模式下内核行缓冲一条线约 **1024 字节**封顶，超出的尾部被
  **静默丢弃**。事故当晚 zsh 提示符时间戳比 pane 创建晚 44 秒（高负载），
  窗口大开。
- **实测证据链**（隔离会话，按 AGENTS.md 配方）：
  - 用 fifo 让 zsh 阻塞在 `.zshrc`（fg=zsh，herdgent 与 herdr 两道闸门
    都放行）可确定性复现：长命令截断、agent 起不来，与生产事故同构；
  - 边界扫描（`pi --version` 探针）：总长 **1020 字节完整执行，1040 截断**；
  - 同样的 1596 字节命令打进已就绪的 pane **完全不截断**——长度本身
    无罪，竞态窗口 + 超长才是组合条件；
  - `pane send-text` 2000 字节全量送达不受影响——1024 只卡
    `agent start` 组命令那条 typing 路径。
  - 历史事故两次对上：2026-08-02（0.7.5）截在 1023；2026-09-22（0.9.1）
    截在 1022。边界跨版本稳定。
- **旧修复为什么挡不住**：`ARGV_TASK_LIMIT=1200` 只量任务体、不量
  kind+flags+profile 提示词——任务体 613~1200 的内联分支照样把总长推过
  1024。任务体 >1200 的走路径版（短命令）所以一直没事，残差窗口正是
  613~1200 这一段。
- **修复（commit 见 git log，2026-09-23）**：`lib/worker.mjs` 的
  `TYPED_COMMAND_BUDGET = 960`——预算管【整条敲入命令】（kind+全部
  flag+profile 提示词+初始 prompt，含单引号转义膨胀的上界估算）；
  预算内短任务照旧内联，超预算自动回退「只传 task.md 路径」（任务本来
  就写进了 task.md）；固定部分自己吃掉预算时抛 `opening_prompt_overflow`
  显式失败（指向该缩的 profile 提示词），不再静默截断。竞态窗口内
  ≤1024 的命令完整可缓冲，shell 醒来后照常执行——端到端验收：fifo
  阻塞 zsh + 1187 字节任务 + 立即 spawn → 命令 120 字符、pi 正常 active。
  三家 harness 现实最长 profile（~420 字节）最坏组合实测 pi 725 /
  claude 784 / codex 693，余量充足。
- **编排者不再需要**手工控制 task 长度——超长任务自动走 task.md 路径版。
- **后续可选**（未做）：pi 的 `--append-system-prompt` 支持「文件内容」，
  若哪天 profile 提示词需要超过 ~460 字节，可把它落文件传路径再省
  ~400 字节预算；claude 的对应 flag 是纯文本，没有这层退路。

## 2. explore 档 worker 的工具面（fox 的适用边界，未修——边界如此设计）

- **实测**：启动命令带 `--tools read,grep,find,ls`。pi 的 `--tools` 是白名单
  语义，覆盖 built-in / extension / custom tools（`pi --help` 原文）。
- **推论**：explore worker 就是为本地代码库调查设计的，没有 bash。MCP 工具
  是否被该白名单一并过滤**未实测**（发现当日 worker 没起来，无活体样本）
  ——待验证项，不是结论。
- **边界结论**：纯外部联网调研（对象不在本地文件系统）目前 fox 派不动——
  worker 即便起来也可能没有联网面，编排者自己反而持有搜索类 MCP。那次
  「调研 Ploy.ai」最终由编排者直接检索完成。若想让 fox 承接外部调研，
  需要 GG 裁决：给 explore profile 增补只读 web 面，或新增一个带搜索
  MCP 白名单的 research profile。

## 台账

- run：`run-mucket8p054`（failed，未 finalize）；worker `mucket9j3ui`
  （failed，transcript 从未就绪）。
- 发现：2026-09-22（Her 角色按 fox 流程调研外部产品时中途落盘，先搜重
  docs/ 无同项）；根因定位与修复：2026-09-23（同角色，按 GG 指令）。
- 修复验证：`test/opening-prompt.mjs` 22 项全绿（含事故回归、三家最坏
  组合预算、溢出报错）；全量 `npm test` 通过；隔离会话端到端验收通过
  后已按配方收场。
