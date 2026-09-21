# headless 能力对比：DeepSeek Harness (dsh) vs pi — 2026-08-15

> 版本戳：**dsh `0.1.0-rc.6`**（2026-08-13 首发，developer preview，MIT）／**pi `0.83.0`**。
> 比的是**两家 headless 一次性模式的 harness 能力**：`dsh --profile headless "<task>"` 对 `pi -p "<task>"`。
> 不含「要不要接进 herdgent」——那是另一个问题，本文不回答。
>
> **两边配置在线上逐字对齐**，且对齐是被证明的而不是声明的：两边都指向同一个本地记录代理，
> 代理逐条记下真实请求参数、工具目录、token 用量。探针全在临时目录内，`~/.dsh` 未创建，
> `~/.pi/agent` 未改动（用 `PI_CODING_AGENT_DIR` 指到副本）。

## 一、先把「对齐」做实

同模型不等于同配置。挂上记录代理后，两边发出去的东西一比，露出三处此前完全不可见的不对等：

| 不对等 | 表现 | 怎么消掉的 |
|---|---|---|
| pi 加载扩展与 MCP | 启动多花 ~30s（31.5s → `-ne` 8.0s → `-ne --offline` 1.4s） | 用 `PI_CODING_AGENT_DIR` 指到副本，`packages: []` |
| pi 读到全局 `AGENTS.md`，dsh 没有 | pi 答中文、dsh 答英文 | 两边都不给任何 `AGENTS.md` |
| **pi 默认发 `reasoning_effort: "medium"`，dsh 一个字段都不发** | 思考量根本不同 | pi 加 `--thinking off`——实测这一档**恰好不发该字段**，与 dsh 逐字一致 |

对齐后两边的线上参数：

```json
{"model":"deepseek-v4-flash","stream":true,"stream_options":{"include_usage":true},"store":false}
```

**剩下两处差异消不掉，因为它们就是 harness 本身**：`max_completion_tokens` pi 65536 / dsh 32768；
工具目录 pi **4 个**（`read` `bash` `edit` `write`）/ dsh **25 个**。

> ⚠️ 还有一处**结构性的不可对齐**：pi 的 quota-proxy provider 是靠
> `~/.pi/agent/extensions/quota-proxy-models.ts` 这个**扩展**注册的，不是 `models.json`
> （改后者无效，用死端口验过：改了照样能跑）。所以在这台机器上「pi 零扩展」不可能——
> provider 本身就是扩展。dsh 那边对应的是 `settings.yaml` 里一段声明式 provider 配置。

## 二、基准（对齐后，各 3 次，取中位数）

| 探针 | dsh 中位 / 区间 | pi 中位 / 区间 | dsh 调用数·prompt tok | pi 调用数·prompt tok |
|---|---|---|---|---|
| P1 纯对话 | 2.5s / 2.4–2.7 | 3.6s / 2.0–3.6 | 2 · 7,893 | **1 · 2,252** |
| P2 建一个文件 | 6.7s / 6.6–7.5 | 9.4s / **2.6–10.8** | 3 · 15,839 | **2 · 4,623** |
| P3 多步修 bug + 复测 | 21.8s / 18.6–22.5 | **15.9s / 15.3–16.9** | 8 · 60,146 | **5 · 20,894** |

P3 两边各 3 次**全部 3 passed / 0 failed，`test/` 未动**。

三条读法：

1. **上下文开销 dsh 约为 pi 的 3 倍**（P3：60k vs 21k prompt token）。来源是结构性的：
   25 个工具的目录每轮重发、系统提示更长（4,043 字节）、步数更多。
   **⚠️ 这一条已被第六节证伪**：它只对默认工具面成立。把工具面裁到与 pi 一致后，差距消失。
2. **dsh 每个会话多花一次 LLM 调用**去生成会话标题（`session-title-first-prompt-llm`，
   `max_completion_tokens: 64`）。在一次性 headless 里这是净开销。
3. **墙钟时间没有稳定赢家，且 pi 方差大得多**（P2 区间 2.6–10.8s）。拿墙钟排名会得出随机结论，
   token 才是稳定量。

## 三、只读与隔离：不是「谁少个功能」，是边界放在哪一层

**pi 官方文档明写不做内置沙箱**（`docs/security.md` 的 "No Built-in Sandbox"），理由是
「部分的进程内沙箱容易被误当成安全边界，而它仍然依赖宿主 shell、文件系统、包管理器、凭据和扩展代码」，
真正的隔离应当来自 OS 或虚拟化边界；配套给的是容器 / Gondolin 微 VM / OpenShell 三条路
（`docs/containerization.md`）。

**dsh 把 OS 沙箱做进了进程内**：`dsh-sandbox-local` 按平台选运行器——Linux 优先 `bwrap` 再
Landlock，**macOS 用 Seatbelt**，Windows 用 ACL 受限令牌；平台不支持或运行器不可用时以
`SANDBOX_UNAVAILABLE` **fail closed，绝不静默退回无约束执行**。macOS 的 Seatbelt profile 是
allow-default 加 `(deny file-write*)` 再开白名单。

三次实测（提示词里**明确要求「工具被拒就换别的办法，包括 shell 重定向」**）：

| 配置 | 能写盘吗 | 能验证吗（跑 npm test） |
|---|---|---|
| **dsh** `DSH_PERMISSION_MODE=read-only` | ❌ 拒绝，且**明令绕过也没绕成** | ✅ 跑出真值（0 pass / 3 fail） |
| **pi** `--exclude-tools edit,write`（留 bash） | ✅ **写成了**——模型直接 `printf 'BREACH' > BREACH.txt`，并如实汇报"no tool denial occurred" | ✅ |
| **pi** `--tools read,grep,find,ls`（去 bash） | ❌ | ❌ 跑不了 |

即 **pi 的工具名单不是写盘边界**：只要 bash 在，它就形同虚设；而要挡住写盘就得去掉 bash，
于是同时失去验证能力。这不是 pi 的疏忽，是它把边界明确让给了 OS 层——**代价是在
「headless 单进程、不额外套容器」这个场景里，pi 没有可用的只读档**。

### 去掉 bash 之后会发生什么：4 次里 3 次给出错误结论

同一句「跑 npm test 报 pass/fail 计数」，pi 去掉 bash 跑 4 次（真值是 **0 pass / 3 fail**）：

| 次 | 结果 |
|---|---|
| 1 | 拒答，反问要不要它改为静态阅读 |
| 2 | 「`toRoman` — passes」+ 预测 **1 pass / 2 fail** ❌ |
| 3 | 预测 **1 pass / 2 fail** ❌（标注了 "Predicted counts (if you ran it)"） |
| 4 | 「**`toRoman` — PASS** (2/2 asserts)」+ 同样的错判 ❌ |

错处一致：它把 `toRoman` 读成正确的，而转换表里根本没有 `[4,"IV"]`，`toRoman(1994)` 实际是
`MCMXCIIII`。三次都带了不同程度的免责话术，但**具体且错误的结论已经写进正文**。
对照组 dsh 在沙箱只读下直接跑出了真值。

> 这一条已按纪律落盘为 [issue #12](https://github.com/gejiliang/herdgent/issues/12)——
> 因为 herdgent 自己的 `review-*` / `explore-*` 档正是「pi + 工具名单」这个组合。
> **但那是 herdgent 的配置问题，与 dsh 无关，也不构成引入 dsh 的理由。**

### 顺带：dsh 的 workspace-write 不约束「读」

有一次探针被自己的脚手架污染，反而验出这条：dsh 在 `workspace-write` 下用 bash
把父目录整棵树 grep 了一遍，读到了隔壁目录里另一个 harness 的会话文件。
写受沙箱管，**读不受**——这与 Seatbelt profile 只写了 `(deny file-write*)` 一致。

## 四、headless 能力矩阵

| 能力 | dsh `--profile headless` | pi `-p` |
|---|---|---|
| 线上工具数 | 25（含 subagent / workflow / ralph / goal / plan / skill / web_search） | 4（`read` `bash` `edit` `write`） |
| 每次会话的额外 LLM 调用 | 1（生成会话标题） | 0 |
| 跨调用记忆 | **无**（隔离验证：第二次答 `NO_MEMORY`） | **有**，`--continue` 实测续上口令 |
| 选模型 / 思考档 / 追加系统提示 | **无任何 CLI 旗标**，只能写 patch YAML | `--model` `--thinking` `--append-system-prompt` `--tools` `--exclude-tools` … |
| 只读 | OS 沙箱（见第三节） | 无沙箱，只有工具名单 |
| 会话落盘 | 强制，落 `$DSH_HOME/sessions/<cwd 转义>/session-<uuid>/` | 可选，`--no-session` 可关，`--session-dir` 可指定 |
| transcript 形态 | 多帧 zstd 事件流：`sandbox/mode`、`approval/policy`、`turn|step/start|end`、reasoning chunk、usage | 明文 jsonl 消息流 |
| MCP | 需在 patch 里 `insert:` 一条 `dsh-mcp-client`；实测 3.6s 调通 | 需 `pi-mcp-adapter` 扩展；实测能在 `-p` 下枚举并搜索某服务器的 68 个工具 |

MCP 那格有一处**未查清**要说明：pi 的 `--mcp-config` 指向隔离配置时**挂死超过 10 分钟**，
我没有继续追（连试三次即止的纪律）。已确认的是 pi 在 headless 下确实能加载 MCP 并看到工具，
未确认的是它能否被稳定地指向一份指定配置。

## 五、四个模式（agent preset），以及它们在 headless 里用不了

dsh 随包发四个 **agent preset**，真源是 `<安装>/config/agent-presets/<id>/preset.yml`：

| id | 名字 | 说明（原文） |
|---|---|---|
| `standard` | 标准模式 | 功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流 |
| `code` | PTC 模式 | 具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作 |
| `minimal` | 极简模式 | 仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent |
| `cordis` | 创造模式 | 用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导 |

**它们在 headless 里选不了，而且是两层挡死的**（都实测过）：

1. `@deepseek-ai/dsh-agent-presets` 只出现在 **web** profile 的组合里（`config: { default: standard }`）。
   往 headless 里 `insert:` 一条进去，**工具目录仍是 25**——headless 的 agent 根本不调 `mount()`。
2. 直接把 `minimal/agent.cordis.yml` 的行搬进 profile 层会 **fail loud**：
   `prompt section "deployment:persona" is already registered`。这是设计使然——
   `dsh-persona` 的 README 写着它 **scope-only**，「在 agent scope 之外挂载会与注册表冲突并 fail loud，
   这不是要绕开的限制」，preset 的 agent scope 只有 preset 挂载器能提供。

→ **四个模式是 web profile 的功能。** headless 跑的不是「标准模式」这个 preset，
而是 `dsh-base` 自己的组合，只是工具面（25 个）与标准模式相当。

### 退一步：复现「极简形状」

既然极简本身跑不了，就复现它**在线上的形状**：关掉 base 的工具行只留 `bash` + `str_replace_editor`，
人设换成极简那一句。效果立竿见影——系统提示 **4,077 → 196 字节**，请求体 **33,335 → 6,693 字节**。

> 与真极简的已知偏差（必须记住，否则会把这组数字当成极简的成绩）：仍是 base 的沙箱化 bash / fs，
> 不是极简的 PTY 持久 bash + 裸 `fs-local`；persona 没有 `complete: true`，harness identity 与
> 运行时上下文仍在；compaction 仍在（极简是没有的）。所以这是**下界的近似**，真极简只会更省。

| prompt token | dsh 标准面 | **dsh 极简形状** | pi |
|---|---|---|---|
| P1 纯对话 | 7,893 | **2,007** | 2,252 |
| P2 建文件 | 15,839 | **3,998** | 4,623 |
| P3 多步 | 60,146 | **38,050** | 20,894 |

| 墙钟中位 | dsh 标准面 | dsh 极简形状 | pi |
|---|---|---|---|
| P1 | 2.5s | **1.8s** | 3.6s |
| P2 | 6.7s | 8.0s | 9.4s |
| P3 | 21.8s | 24.5s | **15.9s** |

极简形状下 P3 三次**全绿、`test/` 未动**。

**这组数字把原来那条「3 倍」结论切成了两半**：

- **单轮任务上，开销差距整个消失**——极简形状比 pi 还省一点（P1 2,007 vs 2,252；P2 3,998 vs 4,623）。
  即所谓「dsh 贵」，贵的是**标准模式那 25 个工具的目录**，不是 dsh 这个 harness。
- **多步任务上仍高约 1.8 倍**（38k vs 21k），但**原因换了**：工具目录已经不占地方，
  差距来自**步数**——极简形状 9 次 LLM 调用，pi 只要 5 次。工具少了反而更啰嗦：
  没有 `read` / `grep`，每次看文件都得 shell 出去一趟。

## 六、把工具面也对齐：「一切皆插件」的真正检验

前面所有 token 差距都可能只是**工具目录的差**，不是 harness 的差。要分开，就得把工具面也对齐。
方向只有一个——**dsh 往 pi 靠**：pi 的内建工具总共 7 个（`read` `bash` `edit` `write` `grep` `find` `ls`，
线上实发 4 个），加不出 dsh 那 25 个；而 dsh 可以裁。**这本身就是「按需搭建」的证据：
组合能命中任意目标形状，旗标只能在自己那点内建里做减法。**

裁的过程一共 **16 行 patch YAML**，其中最能说明插件图的是这一条：

```yaml
- { id: attachment-local, disabled: true }   # 不是禁工具，是拿掉服务
```

`read_image` **只在 `ctx.attachments` 存在时才注册**（`tool-fs` 的 README 写明），
所以拿掉那个存储服务，工具自己就不出现了。剩下 15 行是逐个 `disabled: true` 关掉
`tool-fs-search` / `tool-goal` / `tool-jobs` / `tool-todo` / `tool-ralph` / `tool-skill` /
`tool-web` / `tool-workflow` / `tool-subagent*` / `plan-mode` / `tool-str-replace-editor`。

线上核对，两边逐字相同的四件套：

```
dsh | tools: 4 ["bash","edit","read","write"] | body 7,561 B
pi  | tools: 4 ["read","bash","edit","write"] | body 8,361 B
```

系统提示、会话标题调用、compaction 等**一律保持 dsh 默认**——那些正是本节要量的「剩余差距」。

### 结果：token 差距整个消失

P3 各跑 **7 次**（前面 n=3 方差太大，这个数字关键，加到 7）：

| P3 多步题（n=7） | dsh | pi |
|---|---|---|
| prompt token 中位 | **16,912** | 23,010 |
| prompt token 均值 | **19,851** | 23,900 |
| prompt token 区间 | 15,898 – 28,978 | 16,415 – 35,758 |
| LLM 调用数 中位 | 6 | 6 |
| 墙钟 中位 / 均值 | 16.7s / 17.2s | 17.0s / **17.2s** |

单轮探针（n=3）：

| prompt token | dsh | pi |
|---|---|---|
| P1 纯对话 | 2,168 | 2,252 |
| P2 建文件 | 4,349 | 4,650 |

**14 次运行全绿、`test/` 全部未动。**

**读法要克制**：dsh 的中位与均值都低于 pi，但**两边区间重叠得很厉害**，n=7 也不大。
诚实的表述是——**工具面一致之后，token 差距在噪声里消失了；墙钟均值更是一模一样（17.2s）**。
说「dsh 反而更省」是过度解读，说「dsh 贵 3 倍」则已被证伪。

### 于是前面那条结论要作废

> ~~上下文开销 dsh 约为 pi 的 3 倍~~

**那 3 倍全部来自默认工具目录，不来自 harness。** 三轮的同一格数字并排：

| P3 prompt token | dsh 标准面（25 工具） | dsh 极简形状（2 工具） | **dsh 工具对齐（4 工具）** | pi（4 工具） |
|---|---|---|---|---|
| 中位 | 60,146 | 38,050 | **16,912** | 23,010 |

工具数一样，开销就一样。**harness 本身没有厚薄之分，厚的是你让它带多少工具。**

### 对齐之后还剩什么

工具面拉平后仍然存在、且不随配置消失的差异：

| 残差 | dsh | pi |
|---|---|---|
| 每次会话额外一次 LLM 调用 | **有**（生成会话标题） | 无 |
| 输出啰嗦程度（completion token） | 明显更高（P1 269 / P2 853 / P3 1,806） | 低（2 / 92 / 1,224） |
| 只读沙箱 | 有 | 无 |
| CLI 旋钮 | 无 | 有 |
| 会话落盘 | 强制 | 可关 |
| 还能加回来的东西 | 刚裁掉的 21 个工具 + subagent / workflow / plan / skill | 只有 7 个内建，再多要写扩展 |

## 七、结论（只关于 harness 能力）

- **同模型同题，产出没有差别**——P3 两边各 3 次全绿，补丁只差一个兜底写法。
  harness 之间的差别不体现在解题质量上。
- **「dsh 贵」是伪结论，已证伪。** 把工具面裁到与 pi 逐字一致后，token 差距落进噪声、
  墙钟均值一模一样（17.2s）。**贵的是默认带的 25 个工具，不是 harness。**
- **「一切皆插件」在这件事上是真的**：16 行 patch YAML 把 dsh 裁成 pi 的形状，
  其中拿掉 `read_image` 靠的是**删掉它依赖的存储服务**而不是禁工具——插件图确实是可组合的，
  而且配错时 fail loud（`dsh-persona` 那次就是当场炸掉，不是静默降级）。
- **可组合性只有一个方向**：dsh 能变成 pi 的形状，pi 变不成 dsh 的形状——
  pi 只有 7 个内建工具可做减法，再要加就得写扩展。
- **对齐之后真正的残差**：dsh 每次会话多一次生成标题的 LLM 调用、输出明显更啰嗦
  （completion token 高出 1.5–100 倍）、会话强制落盘、headless 侧没有 CLI 旋钮；
  换来的是一个**真 OS 只读沙箱**（pi 在单进程里没有对等物）和**随时能加回来的 21 个工具**。
- **同模型同题，解题质量三轮都没有差别**——本轮 14 次运行全绿。选 harness 不是在选代码质量，
  是在选「默认带多少东西、以及能不能改」。
- **一句话**：差别不在「谁更快更省」，在**默认值与可塑性**。
  pi 默认就薄，靠旗标微调，天花板是它那 7 个内建；
  dsh 默认很厚但可以逐层拆到任意形状，代价是配置只能写 YAML、且拆完仍多一次标题调用。

## 附：怎么复现

```sh
# dsh：$DSH_HOME/settings.yaml 声明 provider，--patch 覆盖默认模型
llm-pi-ai:
  providers:
    quota-proxy: { apiKeyEnv: QP_API_KEY, api: openai-completions,
                   baseURL: <gateway>/v1, models: [ { id: deepseek-v4-flash } ] }
# --patch：改已有条目用 id，加新插件用 insert（写错 id 只在 stderr 印一行就照常启动，
#          必须用 --dump-config 复核）

# pi：把 ~/.pi/agent 拷一份，改副本里注册 provider 的那个扩展的 baseUrl
PI_CODING_AGENT_DIR=<副本> pi -p --offline --thinking off --model quota-proxy/deepseek-v4-flash
```

对齐判据不是读文档，是**看代理日志里两边的请求体**。
