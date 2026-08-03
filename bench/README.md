# harness-bench — 同模型下的 harness 横向评测台

**问题**：把模型固定成同一个，五个 harness 干同一类活，差距有多大、差在哪。

**边界**：这个目录**不属于 herdgent 本体**。它借住在这个仓库里，但不参与插件运行——
`herdr-plugin.toml` 只声明 `bin/*.mjs` 的具体路径，不打包目录。
改 `bench/` 不影响 herdgent，改 herdgent 也不影响 `bench/`。别把两边的概念混着写。

固定模型：**`deepseek-v4-flash`**（经 quota-proxy 网关 `newapi.gejiliang.com`）。
⚠️ 网关同时挂着 `ark-deepseek-v4-flash`（火山方舟入口），是**不同上游**，别混用。

---

## 现状（2026-08-04 实测）

两道前置门都已全绿。

| harness | 入口 | wire | 说话 | 用工具 |
|---|---|---|---|---|
| claude | `claude -p` | `/v1/messages`（Anthropic） | ✅ 2.0s | ✅ 4.7s |
| codex | `codex exec` | `/v1/responses` | ✅ 3.0s | ✅ 3.9s |
| opencode | `opencode run` | `/v1/chat/completions` | ✅ 9.9s | ✅ 6.3s |
| pi | `pi --print` | `/v1/chat/completions` | ✅ 1.4s | ✅ 4.1s |
| kimi | `kimi --prompt` | `/v1/chat/completions` | ✅ 3.6s | ✅ 11.7s |

上面的秒数是**冒烟耗时，不是性能结论**——n=1，且任务小到没有区分度。

**wire 格式不同是记录变量，消不掉**：claude 走 Anthropic 协议、codex 走 responses、
其余三家走 chat/completions。三条都实测 HTTP 200，但网关的协议转换质量会计到对应
harness 头上。任何结论都必须标明这一条，不能假装五家走的是同一条路。

---

## 怎么跑

```sh
node bench/smoke.mjs            # 门一：能不能说话（全部）
node bench/smoke.mjs claude pi  # 只跑指定的
node bench/tool-smoke.mjs       # 门二：能不能真的读写文件
```

失败时看 `bench/.runs/<时间戳>-<harness>-<tag>/{stdout,stderr}.txt`——
每次运行的原始输出都落盘，改判分器不需要重跑（重跑 = 真金白银的 API 调用）。

## 隔离机制

**两条，都是结构性的，不是保险动作。**

### 1. 每次运行一个全新的假 HOME

`homes/<harness>/` 是模板，运行时复制到 `.runs/<ts>-.../home`，跑完删掉。

不只是为了不碰 GG 的配置。**更要紧的是屏蔽全局指令注入**：
不隔离的话 claude 读 `~/.claude/CLAUDE.md`→`~/.agents/AGENTS.md`、
codex 读 `~/.codex/AGENTS.md`、kimi 读 `~/.kimi-code/AGENTS.md`……
五家拿到的系统提示量各不相同，那测的是「谁的全局配置写得好」，不是 harness。

不复用 HOME 同理：harness 会在里面攒 session / todo / 项目记忆，
第 2 次跑就不再是干净起点，同一任务的多次重复也就不可比了。

### 2. 密钥永不入库

`bin/with-key.sh` 是**唯一**接触密钥的地方，评测台的 JS 代码全程不经手明文。

它做三件事，顺序是 load-bearing 的：

1. `source ~/.zshrc` 拿 `NEWAPI_API_KEY`（密钥定义在那里，
   而 `.zshrc` 只有 interactive shell 会自动读——`zsh -l` 读的是 `.zprofile`/`.zshenv`，**实测拿不到**）；
2. 把 `__NEWAPI_KEY__` 占位符换成真值（只有 pi / kimi 需要，见下表）；
3. **最后**才把 `HOME` 切到假 HOME 再 `exec`——顺序反了就会去读 `$BENCH_HOME/.zshrc`（不存在），拿不到密钥。

| harness | 密钥怎么给 | 落盘吗 |
|---|---|---|
| claude | `ANTHROPIC_AUTH_TOKEN` 环境变量 | 否 |
| codex | `env_key = "NEWAPI_API_KEY"` | 否 |
| opencode | `{env:NEWAPI_API_KEY}` | 否 |
| pi | 配置里只认明文 → 占位符替换 | 是（`.runs/`，已 gitignore） |
| kimi | 配置里只认明文 → 占位符替换 | 是（`.runs/`，已 gitignore） |

---

## 实测踩过的坑

| 症状 | 真因 | 结论 |
|---|---|---|
| stdout 里混进 `\033]2;...` 转义序列 | oh-my-zsh 的 preexec 钩子对**之后每一条命令**都打终端标题；连「清理钩子」那条自己都会触发，躲不掉 | 在 `source` **之前** `exec 3>&1 1>&2`，脚本自身输出全改道 stderr，只把 fd 3 留给受测进程 |
| pi 输出解析成空 | `--mode json` 打的是**事件流**，而且多个对象**空格分隔挤在一行**，不是标准 JSONL | 按括号配对切顶层对象（`looseJsonObjects`），别用 `split("\n")` |
| kimi `Cannot combine --prompt with --auto` / `--yolo` | `--prompt` 模式自带固定权限语义，拒绝一切权限开关 | 不传权限开关。**实测它默认就允许工具调用**，所以不影响参赛 |
| kimi `Ignored invalid config` + 模型未配置 | provider 缺 `type`，model 缺 `max_context_size` / `capabilities`。报错**不说缺哪个** | 三个字段一个都不能少，见 `homes/kimi/.kimi-code/config.toml` |
| Node 起子进程时继承当前 env | 会把 `CLAUDE_CODE_*` 一路带进受测会话（herdgent 项目文档记过这个坑：transcript 被关、标题串台） | `runner.mjs` 里 env 是**白名单**，不是继承 |

---

## 还没做

**任务设计与判分器**（`tasks/` 目前是空的）。方向已议定但未落地：

- **A 定位型**（只读）——大仓库里回答「X 在哪」，判 `file:line` 是否命中 ground truth。测搜索策略。
- **B 小手术型**——修到失败测试变绿，判 red→green 且没改测试文件。测编辑可靠性 + 纠错闭环。
- **C 约束遵守型**（反向测试）——给明确禁令再诱它越界，判 `git status`。测指令遵守，**对 herdgent 的编排最相关**。
- D 长程压力型 / E 多文件特性型 / F 卡死恢复型——第二轮。

**权限一律全开**是已定的设计：评测要测的是指令遵守度，不是沙箱强度。
C 类靠 prompt 里的禁令来测、靠 `git status` 来判，不靠权限系统拦——
否则测的是对话框，不是能力。

两个尚未实现但已定的指标：

- **token 消耗**——网关侧有统一账本，跨 harness 直接可比，不用信各家自报。
- **虚报率**——同时记录「它自己说成没成」与「客观判分成没成」，差值即虚报率。
  对编排场景是致命指标：herdgent 要不要信 worker 的完成报告，答案就在这个数上。

n=1 没有意义。最低配 5 harness × 3 任务 × 3 次 = 45 次运行。
