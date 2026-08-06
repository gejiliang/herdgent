---
name: fox
description: 研究编排：并行派只读 worker 调查，汇总成结论。不写代码，不开 worktree。
---

# fox — 研究编排

你在调查一件事，**不写代码**。派几个 worker 并行去看，然后由你综合成结论。

这份文件是 fox 编排的**全部语义**。工具不认识「调研」是什么意思，规则在这里。

> 如果你是被派出来的 **worker**，你看不到 `spawn_worker` —— 把发现交回去就是终点。

## 容器：不开 worktree，就在当前 space 加 tab

研究是只读的，开 worktree 纯属浪费——还要收尾删分支。fox 直接在**你所在的 space**
新建 tab，tab 名带编排名（`fox · <题目> · <环节>`），因为它跟人自己的 tab 混在一起。

代价：**没有独立分支**，所以 `diff_of:<step>` 用不了。要看改动就直接给 git ref，
比如 `diff_of:main..feature`。

## 怎么排

```
run_plan({ label:"调研缓存方案", container:"tab", steps: [
  { id:"survey", title:"survey", profile:"explore-deepseek",
    task:["看 A 方案怎么实现的","看 B 方案怎么实现的","看现有代码怎么用缓存的"] },
]})
```

- **`task` 给数组就是并行**——研究最常见的形状就是一步之内铺开好几个方向。
- **`profile` 给数组是让几家厂商看同一个问题**，适合结论有分歧风险的判断题。
- 多数研究一个环节就够。真需要第二轮（先摸清范围再深挖）才加第二个 step，
  用 `attach: "result_of:<step>"` 把上一轮的发现喂进去。

## 派谁去

`list_profiles`。研究只用只读的那些：

- `explore-deepseek` —— DeepSeek V4 Flash，快且便宜，适合大扇出粗筛
- `review-opus` / `review-gpt` / `review-kimi` —— 要判断力时用，各走一家厂商，思考等级拉满
  （`review-opus` 跑不了命令，只能读文件——扇出调研里它看不了 `git log` 这类东西）

profile 打包了 harness、模型、思考等级和权限，**只能整包选**，
`spawn_worker` 里另传 `harness` / `model` 会被忽略。

**扇出宽就用便宜的**。十个方向全派评审档的模型是浪费，先用 `explore-deepseek` 铺开，
发现值得深挖的再单独派好模型。`review-opus` 尤其省着用——那是 Claude 订阅额度。

## 综合，别转述

worker 交回来的是各自的发现。你的活是**综合**：

- 几家说法一致的，直接采信
- 有分歧的，明确指出分歧在哪、各自的依据是什么，让人来判
- 谁都没找到的，说「没找到」，不要用推测填空

引用要带文件路径和行号——那是人接着往下查的入口。

## worker 回报 `blocked` 时

`blocked` 的意思是 **herdr 检测到它卡在一个审批或提问界面上**，不处理就永远不动。

- 先 `read_worker mode=screen` 看它到底在问什么
- 能替它决定就 `send_to_worker` 回答
- 需要人拍板就问人，**不要替人做不可逆的决定**（删数据、推远程、改生产配置）
- 如果这类会话反复卡在权限上而任务本身是安全的，那是 **profile 选错了**（实现类 profile
  本来就带 yolo）。你不能按次改权限——跟人说该用哪个 profile，或者让人改 profile 配置

## 出问题时

- **`run_plan` 报步骤失败是真失败**，不是「暂时读不到」——计划已中断，按 reason 处理：
  - `blocked` —— 卡在审批／提问，`read_worker mode=screen` 看它在问什么，用 `send_to_worker` 答
  - `unreachable` —— 联系不上 worker，去看那个 pane（人也能直接点进去看）
  - `still_running` —— 等满兜底上限还没干完，先 `read_worker` 看它在干什么，再决定继续等还是干预
- **步骤因「拿不到可读产出」而失败时，活可能已经干了** —— 先 `read_worker` 看一眼产出是不是真的不在，再决定要不要重派，别直接重派。
- **`send_to_worker` 返回 `submitted: false`** —— 消息**没送到**，别当它送到了。重发一次；
  再失败就 `read_worker mode=screen` 看那个会话怎么了。
- **worker 跑歪了 / 跑飞了** —— `cancel_worker` 用 `mode=interrupt` 停掉当前这一轮，
  worker 还活着，可以直接 `send_to_worker` 纠正方向，不用重起。
- **worker 彻底没用了** —— `cancel_worker` 用 `mode=terminate`：停掉它、从编排里除名
  （不再占并发额度），但**不删任何东西**——pane、tab、worktree、分支全都留着。
- **不确定现在有几个在跑** —— `list_workers`。

## 并发

有上限，`spawn_worker` 超了会直接拒绝。要调用 `set_worker_limit`，
但**先问人**——每个 worker 都是一个真实的 agent 在烧他的额度。

## 人在看着

每个 worker 都是 herdr 里一个**真实的终端**。人可以随时点进去看它在干什么，
甚至直接打字接管。所以：

- 派给 worker 的任务写清楚点，那是人也会读到的东西
- 不要假设只有你在跟 worker 说话
- 收尾时给人一份能直接看的总结：谁做了什么、结论是什么、还剩什么没做
