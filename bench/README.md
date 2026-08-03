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
| `RangeError: Invalid string length`，整批崩在某一家 | 把 stdout 一路 `+=` 成字符串，pi 跑评审时输出超过 V8 的字符串上限（它的 `--mode json` 会把读到的文件内容也吐出来） | 流式写盘 + 内存只留 16MB 尾部（各家答案都在末尾）。顺带把 `stdoutBytes` 变成一个指标 |
| 清理运行目录时 `EACCES` | 受测 harness 在假 HOME 里跑构建，Go module cache 是只读的 | 删之前先 `chmod -R u+w`（`hardRemove`）。**根治办法是任务层面禁止构建**，见下 |
| 耗时被网络下载主导 | 每次运行都是全新假 HOME → 工具链缓存不命中 → 每次重下（实测 pi 拉了整条 Go toolchain） | 评审任务在 prompt 里**明确禁止构建/运行**（真实 code review 本来就不编译）；前端任务把 `node_modules` **预装进 fixture** |
| 判分器把标准答案判成 12/14 | 用 `findIndex` 取第一个匹配的标注，位置重叠时前一条把两次匹配都吃掉，后一条永远无人认领 | 一对一贪心配对：优先认领没被占过的标注 |
| 断言全绿但 bug 明明在 | `toHaveTextContent` 是**子串匹配**，`"1290.50"` 能通过 `"90.50"` 的断言 | 金额一律用 `.textContent).toBe(...)` 精确比较 |
| `import` 一下就把 fixture 重建了 | `build.mjs` 顶层无条件 `await build()`，而 `run.mjs` 要 import 它的 `TASKS` | 只在 `process.argv[1]` 是自己时才 build |

---

## 任务

两类，各三道**难度梯度**题。梯度不是为了好看：全对或全错的题没有信息量，
随机取样大概率抽到这两头。基线题是校准线（在这题上失手才说明真出了问题），
分化题是差距的主要来源，难题看的是失败时的姿态（干净放弃 vs 谎报完成）。

### 评审 `tasks/review/`

题库是 **AACR-Bench**（阿里，196 个真实 PR + 专家标注的 positive/negative 意见）。

```sh
git clone --depth 1 https://github.com/alibaba/aacr-bench bench/tasks/review/.aacr
node bench/tasks/review/build.mjs           # 造题面
node bench/tasks/review/verify-fixtures.mjs # 【必跑】标注能不能在题面里定位
node bench/tasks/review/score.test.mjs      # 【必跑】判分器自测
node bench/tasks/review/run.mjs --reps 3
```

**196 个 PR 里只有 12 个真能用。** 三道门槛依次卡掉：target commit 被 GC（11 个）、
`source...target` 已 diverged 拿不到干净 diff、标注文件不在 diff 里。
最后一道最阴 —— ollama#12185 的 commit 完全取得到，但 compare 是 `diverged`，
API 给的 23 个文件混进了另一条线的改动，而标注只覆盖 9 个。
**拿这种 diff 对行号，判分照样跑出数字，只是数字没有意义**，所以 `verify-fixtures.mjs` 是必跑的。

| 档 | PR | 该报 | 诱饵 | 考什么 |
|---|---|---|---|---|
| 基线 | ollama/ollama#9379 | 5 | 0 | 纯 Diff Level，信息全在 diff 里 |
| 分化 | libsdl-org/SDL#12964 | 7 | 1 | 只改 48 行却埋着 7 个问题，2 个要跨仓库看 |
| 难 | wavetermdev/waveterm#1998 | 14 | 7 | 13 个文件，该报 14 个、埋了 7 个诱饵 |

判分**主指标零 LLM**：文件路径 + 行号区间重叠 → Line Precision / Recall / Noise Rate。
`formatStrict` 单独记 —— 内容能不能解析、守不守输出契约是两回事，
合并的话「找得准但格式松」和「格式对但什么也没找到」会被压成同一个数。

一条已知瑕疵：SDL 那条 negative 标注（`SDL_hidapi_8bitdo.c:3147`）落在 hunk 外，
判分时永远不会被命中，效果是这题的 Noise Rate 少一个诱饵。

### 前端 `tasks/frontend/`

自建。视觉类公开集（Design2Code / DesignBench / Vision2Web）**全部出局** ——
模型只吃文本，不是选择问题。所以走「需求文本 → 代码 → 行为断言」。

```sh
cd bench/tasks/frontend/app && npm install   # 一次就够，会被 clone 进每份 fixture
node bench/tasks/frontend/build.mjs
node bench/tasks/frontend/verify-fixtures.mjs # 【必跑】三道题是否都处在「没做」的状态
node bench/tasks/frontend/run.mjs --reps 3
```

一个费用记录应用（表单 / 列表 / 合计 + useReducer）。刻意用 reducer 而不是散落的
useState：这样「加字段」「加筛选」必然要同时动状态和组件，才测得出能不能顺着数据流找全。

| 档 | 需求 | 考什么 |
|---|---|---|
| 基线 | 加备注字段 | 表单收、reducer 存、列表显示，三处都得动 |
| 分化 | 按分类筛选 | 分水岭是**合计要不要跟着筛选走** —— 只改列表不改合计，功能看着是好的但数字不对 |
| 难 | 修「删除后合计不更新」 | 只给症状不给位置。真因是 state 里冗余的 `total` 只在 add 时维护 |

判分两层，**都要记**：`spec`（验收测试，做没做到）+ `smoke`（基础功能，有没有把原来好的搞坏）。
只看前者的话，「功能做出来了但把删除逻辑改崩了」会被记成满分。

隐藏测试放在 `specs/`，**不进 fixture** —— 进去了 agent 就能照着断言写代码，
测的就成了抄写能力。判分时才复制进 `app/__bench__/` 跑。

## 还没做

- **约束遵守类**（给明确禁令再诱它越界，判 `git status`）—— 对 herdgent 的编排最相关，但排在第二轮。
- **后端类**（Aider Polyglot）—— 同上。
- **token 消耗**：网关侧有统一账本，跨 harness 可比，不用信各家自报。目前只记了各家自报的 `usage` 与 `stdoutBytes`。
- **虚报率**：`selfReport` 字段已经存下来了，但还没和客观判分对照统计。
  对编排是致命指标 —— herdgent 到底能不能信 worker 的完成报告，答案就在这个数上。
- **语义匹配辅指标**：judge 用不参赛的 `claude-opus-5`，同一个 judge 评所有五家。尚未接。

n=1 没有意义，正式结论要 `--reps 3`。
