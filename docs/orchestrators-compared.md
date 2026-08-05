# 三种编排范式的实测画像

> `README.md` 开头那张对照表的证据支撑。这里记的是**读过源码 / 读过工具契约之后**的画像，
> 不是从文档转述的。两个参照物都会随上游升级漂移，**引用前先复核版本戳**。

herdgent 不选控制流范式——它只提供动词。但选不选是一回事，知不知道别人怎么选是另一回事。
下面两个是决定 herdgent 边界时真正参照过的对象。

| | 控制流在哪 | 机制层 | 断点续跑 |
|---|---|---|---|
| **polly**（omnigent） | 全在 prompt | 3 条 runner 侧 guardrail | 无，靠 registry.json 当任务表 |
| **Claude Code dynamic workflow** | 母 agent 现编的 JS 脚本 | 调度原语 + schema 校验 + 硬上限 | 有，靠确定性重放 |
| **herdgent** | 使用者的 skill / prompt | 归属边界 + 并发闸 + profile | 无，**且重放本质走不通** |

---

## 一、omnigent polly

**版本戳：omnigent 0.7.0**，2026-08-02 读的源码。随包发的参考编排器，位置
`omnigent/resources/examples/polly/`（uv tool 装的话在 uv tools 目录的 site-packages 下）。
omnigent 升级后需重核。

`AGENTS.md` 拿它当「编排语义不进代码」的参照物，那条引用属实。

### 组成

| 文件 | 行数 | 性质 |
|---|---|---|
| `config.yaml` | 350 | **约 85% 是 `prompt:` 自然语言** |
| `agents/<6 家>/config.yaml` | 65–75 ×6 | 也几乎全是 prompt，实际差异只有 `harness:` 一行 |
| `skills/{fanout,cross-review,investigate}/SKILL.md` | 57 / 68 / 47 | 纯散文 |

**零行编排代码。** 把 prompt 段抠掉，剩下的声明只有：6 个子 agent（`tools.agents`）、
3 条 guardrail、4 个开关（`spawn` / `async` / `cancellable` / `timers`），加 executor / os_env / terminals。
**没有 `Role`、没有 `Workflow`、没有 `Protocol`、没有 `Template`**——这正是 `AGENTS.md`
那条越界判据的出处。

### 唯一的机制层：3 条 guardrail

声明在 config，实现在 `omnigent/policies/builtins/orchestration.py`
（`omnigent.inner.nessie.policies` 是向后兼容 shim），跑在 **runner 侧的 tool gate** 上——
不在 orchestrator 调用的那个工具里，**所以模型看得见 DENY 却绕不过去**。

- **`blast_radius`**（`gate_pushes: false`）——push / merge 不 ASK，但灾难集仍 DENY：
  force-push、`rm -rf /`、hard-reset 到 remote ref。
- **`spawn_bounds`**（`max_dispatches_per_turn: 6`）——`sys_session_create` **也计数**，
  因为 `spawn: true` 让 polly 能自定义子会话，不计数就绕过了上限。
  **但它只管单轮派发数，不管跨轮活跃并发**——源码 docstring 自承是 v1 界限，
  真正的 live-concurrency 记账列为 v1.x 未实现项。代码默认 5，polly 配成 6，是配置项不是写死的。
- **`headless_subagent_purpose_guard`**——每次派发必须声明
  `args.purpose ∈ {implement, review, explore, search}`，否则 fail loud。
  **这是唯一进了代码的编排语义**，且抽象得足够低：是「这次派发干哪类活」而不是「角色」，
  所以没变成类型。herdgent 的 `purpose` 参数抄的就是这个粒度。

### 流程要点

- **每任务一个 worktree**，implementer 各自开自己的 PR，**polly 从不 merge**。
  （herdgent 选了不同粒度——一次编排一个容器，见 findings 第二十节。）
- **跨厂商评审是结构性的**：reviewer 只拿 diff + 验收契约，**绝不给 worktree 或 transcript**；
  且只有 implementer 能开 PR，reviewer 手贱改了也进不了交付物。
- **inbox 驱动，禁止轮询**：派完就结束回合，worker 完成自动唤醒。明令禁止用 timer 查状态。
- **prompt 里花 12 行讲「宣布即执行」**——只说不做的回合没有工具调用，就没有派发，
  也就永远等不到唤醒，**整个 run 静默死掉**。这是踩出来的坑不是设计时想到的。
- **boot 失败 ≠ 任务失败**：worker 缺 CLI 起不来 → 整轮从名册划掉不再重派；
  起来了跑挂了 → 才值得重派。
- **无断点续跑**，靠 orchestrator 用普通 shell 工具维护的 `.polly/registry.json` 当任务表。
- 测试计数单列一条规矩：禁止用 `grep -c 'def test_'` 当 pytest 计数器（漏 parametrize 展开），
  必须 `--collect-only` 对同一 commit 重收才准判 worker 报错数。

### 对 herdgent 的意义

herdgent 比 polly 多走一步：**把机械序列从 prompt 抽成数据**（`lib/presets.mjs`），
判断规则仍留 skill。polly 的 fanout 是让模型每次照散文重演，herdgent 的 `run_preset`
是引擎执行数据。切分更干净，边界结论一致。

---

## 二、Claude Code dynamic workflow

2026-08-02 整理。**这些细节只能从 Claude Code 会话内部读到**（工具契约不在任何仓库里），
落盘是为了 codex / pi 会话也能查。Claude Code 升级后需重核。

### 定位

**母 agent 现场写一段 JS 脚本，由 harness 确定性执行，脚本里每个 `agent()` 起一个 subagent。**

关键差别在谁决定控制流：普通 subagent 是**模型驱动**（每轮都过推理）；
dynamic workflow 是**代码驱动**（循环、分支、fan-out 写死在脚本里，跑起来不再经过模型）。
「dynamic」指脚本是本次现编的。

### 拓扑归属：母 agent 决定，无系统内建模板

分几个环节、每环节几个 agent，**全部由母 agent 写脚本时决定**。三个决策时刻：

1. **写脚本时**——模型判断，无模板可查。
2. **跑脚本时**——代码决定。扇出宽度常是**数据驱动**的（`pipeline(items,…)` 的宽度就是
   `items.length`，而 items 常来自前一步侦查），或预算驱动。
3. **提前存好的**——`.claude/workflows/` 里的 saved workflow 才是真·预设，由用户自己写。

`meta.phases` **纯粹是显示元数据**（进度面板分组标题），不约束脚本。
工具文档里列的 adversarial verify / judge panel / loop-until-dry 等**是散文不是 API**，
没有对应函数，全靠手写 `parallel` + `agent`。

### 两个调度原语

- **`pipeline(items, s1, s2, …)`——默认**。每个 item 独立走完所有 stage，**stage 之间无屏障**；
  墙钟 = 最慢的单项链，不是每阶段最慢者之和。
- **`parallel(thunks)`——屏障**。全部跑完才返回；失败的 thunk 变 `null` 而不 reject。

**屏障只在 stage N 需要全量跨 item 上下文时才对**（全集去重后再做昂贵下游、总数为 0 就早退、
prompt 要引用「其他发现」）。「我得先 flatten/map/filter」不构成理由——
那个 transform 塞进 pipeline 的一个 stage 即可。

### 其它机制

- **`schema` 强制结构化输出**：给了 JSON Schema，subagent 被强制调用 `StructuredOutput` 工具，
  校验在**工具调用层**发生（不匹配模型重试），返回已校验对象。
- **上限**：并发 `min(16, CPU-2)` / 生命周期总量 1000 / 单次调用 4096 item。
  `budget` 是**硬顶**，花完 `agent()` 直接抛。
- **resume**：未改动的 `agent()` 调用前缀走缓存，从第一个改动处才真跑。
  **为保确定性重放，`Date.now()` / `Math.random()` / 无参 `new Date()` 在脚本里会抛异常。**
- **显式 opt-in 才能调**（关键词、用户明说、skill 指令）。「任务明显会受益于并行」不算。

### 对 herdgent 的意义

控制流范式与 herdgent 相反：Claude Code 把模型的编排判断**一次性固化成代码**换执行确定性；
herdgent 只提供动词、范式由使用者的 skill / prompt 定。

**它的 resume 我们学不来**——herdgent 的 worker 是真会话，确定性重放本质走不通，
见 findings 第二十一节。

### 另一个对照：结构化输出

Claude Code 用 `schema` 在工具调用层强制 subagent 产出结构化数据。herdgent 没有等价物——
`read_worker` 取的是 transcript 里最后一条 assistant 文本。这在实测中是有成本的：
**不同 harness 的输出契约呈二值分裂**（codex 稳定输出规范 JSON，claude / pi / kimi 从不，
内容对但要宽松解析）。目前 `run_plan` 不按结果做分支判断，所以还没撞上；
真要做「评审 PASS 才进下一步」这类流程，这里就是第一个坎。
