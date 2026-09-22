# 模型可用性实测 — 2026-08-12

起因：GG 的 ChatGPT 订阅到期不续，要更新 profile 表。结论不是「把 gpt 换成别的名字」那么简单，
因为**原生 Codex 和网关上的 gpt-5.6-\* 兑的是同一份凭据**，一起断。

判据一律是**真发一次请求**，不看任何本地清单——本地清单会骗人，这次又验了一遍（见第三节）。

## 一、OpenAI 两条路都断

| 路径 | 探针 | 结果 |
|---|---|---|
| 原生 Codex | `codex exec -m gpt-5.6-terra "…"` | `You've hit your usage limit. Upgrade to Plus…, or try again at Sep 10th, 2026` |
| 原生 Codex（sol） | `codex exec "…"`（默认模型 sol） | `400 The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account` |
| 网关 | `pi -p --model quota-proxy/gpt-5.6-terra` | `429 model_cooldown` — `All credentials for model gpt-5.6-terra are cooling down via provider codex`，`reset_seconds: 2456297`（≈682 小时 ≈ 28 天） |
| 网关 | `pi -p --model quota-proxy/gpt-5.6-sol` | `502 unknown provider for model gpt-5.6-sol` |

`~/.codex/auth.json` 的 `auth_mode` 是 ChatGPT 订阅态，`OPENAI_API_KEY` 为 `null`——**没有 API key 兜底**。

**网关那条路不是备份**：quota-proxy 的 gpt-5.6-\* 走的是 provider `codex`，凭的就是同一份 ChatGPT
OAuth（参见 homelab 的 CPA / codex token 记忆）。订阅没了，两条路一起没。所以这次不是「换个通道」，
是**整家厂商从编排里消失**。

## 二、还活着的（逐个真跑过）

网关 `/v1/models` 活目录 17 条。下面这些是**实际发请求验过的**，不是从目录里挑的：

| 模型 | 纯对话 | 工具调用（让它建个文件） |
|---|---|---|
| `quota-proxy/kimicode-k3-256k` | ✅ | — |
| `quota-proxy/kimicode-k3` | ✅ | — |
| `quota-proxy/ark-deepseek-v4-flash` | ✅ | — |
| `quota-proxy/deepseek-v4-pro` | ✅ | ✅ |
| `quota-proxy/ark-glm-5.2` | ✅ | ✅ |
| `quota-proxy/ark-minimax-m3` | ✅ | ✅ |
| `quota-proxy/ark-kimi-k3` | ✅ | ✅ |

工具调用探针（比「能回话」严格一档，实现档 profile 必须过这个）：

```sh
pi -p --no-session --model quota-proxy/<model> \
  "Create a file named out.txt in the current directory containing exactly the text TOOLS_OK, then reply DONE."
```

> `kimicode-k3*` 仍然活着这件事值得记一笔：homelab 侧 2026-08-03 记过「Kimi 订阅到期、
> qp 里是僵尸条目、调用返回 auth_unavailable」。**今天实测它正常返回**，说明网关那边已经
> 换了后端（`ark-kimi-k3` 也在活目录里）。**别拿旧记忆当现状**，探针只要几秒。

## 三、本地清单又骗了一次

| 来源 | 说法 |
|---|---|
| pi 静态 `~/.pi/agent/models.json` | 19 条，含 `gpt-5.6-luna`、`kimicode-k2.7`、`bailian-*` 等网关活目录里没有的 |
| pi `settings.json` 的 `enabledModels` | 6 条，其中 3 条是已死的 gpt-5.6-\* |
| 网关 `/v1/models` | 17 条，含静态目录里没有的 `kimicode-k3-256k`、`ark-glm-5.2`、`ark-kimi-k3`、`ark-minimax-m3` |
| **真发请求** | 唯一判据。活目录里的 `gpt-5.6-*` 也是死的 |

即：**活目录也只是「配得上」，不等于「兑得出」**。配额/凭据层的死活只有请求能问出来。

拉活目录的办法（只读，不需要进 homelab）：

```sh
KEY=$(pi auth print-api-key --provider quota-proxy --model kimicode-k3)
curl -s -H "Authorization: Bearer $KEY" https://<quota-proxy 网关地址>/v1/models
```

## 四、由此改了什么

- 删 `impl-gpt`、`review-gpt`。**`lib/harness/codex.mjs` 一行没动**——适配是动词，凭据是配置。
- 实现主力：`impl-kimi`（Moonshot）+ `impl-sonnet`（Anthropic）；新增的 `impl-glm`（智谱 GLM-5.2）是 fallback。
  **主力这一格当天改过两版**：先按旧的「Claude 订阅不做实现」排成 kimi + glm，GG 随即改成
  kimi + sonnet、glm 降为 fallback。理由是 GPT 走后没有第二个够格的非 Claude 主力，
  与其拿 A 级的 GLM 当主力，不如把 Sonnet 提上来——旧排法的前提（有两个 S 级非 Claude 实现者）
  已经不存在了。代价见下。
- 评审第三家：新增 `review-deepseek`（DeepSeek V4 Pro）顶掉 `review-gpt` 的位置。
- `DEFAULT_SESSION_START_PROFILE`：`impl-gpt` → `impl-kimi`。原来选它的理由是「原生订阅，
  比经网关少一层依赖」，这条理由已经作废（OpenAI 的原生通道没了）。现在选 `impl-kimi`
  是因为独立会话长时间挂着，用它不占 `review-opus` 那个池子。
- profile 新增显式 `vendor` 字段。跨厂商评审看的是厂商，而厂商既推不出（sonnet 与 opus 同属
  Anthropic）也不等于 harness（review-kimi 与 review-deepseek 都走 pi 却是两家）。
  `test/profiles.mjs` 现在守着「每个实现者都有别家厂商的评审可配」——这次差点掉进的坑。

**评审档整体降了半级**：GPT 走后，网关上剩下的 S+ 全是 Claude 模型，而 Claude 做 agent 只能走
原生通道，所以评审侧只剩 `review-opus` 一个 S+，第三家是 A 级。订阅回来就该把 S+ 补回去。

**再叠一层**：`impl-sonnet` 提为主力之后，派它的那一路连唯一那个 S+ 也用不上——同厂商不能评
自己家写的东西，只能配 `review-kimi` 或 `review-deepseek`。所以**难判断的活优先给 `impl-kimi`**，
把 `review-opus` 留给它。这条写在 `skills/rex/SKILL.md` 里，代码不认识。
