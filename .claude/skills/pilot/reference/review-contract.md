# 外部评审接口契约

pilot **不裁决自己的 PR**。它依赖一个**外部评审服务**,并且只依赖这份契约——不关心那个服务是什么、
装在哪、谁启动的、扫描哪些仓库。那些是运维细节,对 pilot 不可见,也**不该**被 pilot 引用或启动。

## 契约

> **只要开了 PR,就会有人 review。你的工作是提好 PR、盯住状态、按回执行动。**

| 项 | 约定 |
|:---|:---|
| **排队** | 开 PR 后 **5–10 分钟**内被排进评审队列 |
| **评审耗时** | 进入队列后 **5–10 分钟**完成 |
| **端到端** | 通常 **20 分钟内**给出裁决;超大 PR 例外,更久 |
| **裁决形态** | `APPROVED` 或 `CHANGES_REQUESTED`(不会停在无结论的 comment) |
| **触发再评** | 向该 PR 分支**推新 commit** 即可;不需要通知任何人、不需要重开 PR |

**pilot 侧唯一要做的事:轮询自己 PR 的状态,直到拿到裁决。**

## 监控节奏

用 `scripts/pr-monitor.sh`。它有两种形态:**一次性**(查一次就返回,不自我驱动)和
`--wait-for-verdict`(没有新鲜裁决前保持静默,自带轮询与硬上限)。按场景选驱动方式:

- **刚开完 PR、想立刻盯到回执** → 用 **Monitor 工具**轮询
  `bash <skill>/scripts/pr-monitor.sh --pr <n> --wait-for-verdict`。
  该模式**在没有新鲜裁决前保持静默**——一次性形式会立刻打印,Monitor 会在几秒内就被触发并结束,
  于是「3–5 分钟一次」和 30 分钟上限**根本不会发生**。
  **必须同时设一个 30 分钟的硬上限**(`timeout_ms` 或循环计数),满足任一条件即唤醒:
  - `verdict` 变成 `APPROVED` 或 `CHANGES_REQUESTED` → 按裁决行动。
    **`verdict` 只在评审 commit == 当前 head 时才非 PENDING**:GitHub 的 `reviewDecision` 在推新
    commit 后仍保留 `CHANGES_REQUESTED`,只看它会让 agent 反复 triage 自己早已修好的问题;
  - **到 30 分钟仍是 `PENDING`** → 走下面的「超时了怎么办」。

  **不设上限会让 agent 永久睡死**:契约承诺的是「有服务时约 20 分钟」,但服务不存在或
  没覆盖本仓库时,`PENDING` 会永远是 `PENDING`,没有任何东西来叫醒你。
  上限不是可选优化,是防止无限等待的唯一机制。

  > `pr-monitor.sh` 把 `REVIEW_REQUIRED` 和空值**都归一化成 `PENDING`** ——
  > 它们含义相同(还没有裁决),不归一化会让「不是 PENDING 就唤醒」在没有裁决时误触发,
  > 醒来却找不到对应分支。**只有 `APPROVED` / `CHANGES_REQUESTED` 才算裁决。**
- **通宵推多个 task** → `/loop 10m pilot run`,每轮 `run` 开头自动扫所有 open PR 的回执并行动。
- 想比固定间隔更聪明 → `ScheduleWakeup` 自排下次唤醒。

> 别用裸 `sleep` 空转终端等回执——既占着会话又不省 token。

## 拿到裁决之后(反复循环,直到合并)

```
开 PR → 等回执 ─┬─ APPROVED         → 合并进集成分支 → 清理分支 → 完成
                └─ CHANGES_REQUESTED → 中立 triage → 修 → 推 → 回到「等回执」
```

- **`APPROVED`** → `git-guard.sh merge-pr <n> --integration <b> --squash`,然后 `safe-cleanup.sh --squash-merged`。
- **`CHANGES_REQUESTED`** → 先按 [`review-triage.md`](review-triage.md) 做中立裁决(该改的改 / 判错的
  回评论讲清业务理由 / 不阻塞的记进 [`followup-ledger.md`](followup-ledger.md)),修完推上去
  **自动触发下一轮评审**,回到等回执。
- **`APPROVED` 但带 comment** → comment 不阻塞合并:先合,再把 comment 过 triage。

**这是一个反复的循环,不是一次性的。** 一个 PR 可能经历多轮「评审 → 修 → 再评审」才合并;
每一轮都按上面的节奏等,不要因为"已经等过一次"就跳过监控。

## 等待期间做什么

**等回执不算停工。** 回主循环挑下一个 READY task 继续开工——一个 PR 卡住不该让整条线停摆。

## 超时了怎么办

**本轮**等了超过约定时间(**30 分钟**)仍是 `PENDING`,说明外部评审服务这会儿没在服务本仓库。
判定用 `pr-monitor.sh` 的 **`wait_min`**(从「当前 head 提交时间」和「上一次裁决落地时间」
里**较晚的那个**起算,也就是本轮等待真正开始的时刻),**不是** `age_min`
(那是 PR 自创建起的总时长,再评审轮次一开始就早已超过 30 分钟,拿它判定会在正被评审的 PR 上
立刻误报)。`age_min` 只作参考。这**不是** pilot 能修的,也不要反复重试或猜测原因。做法:

1. **如实告诉用户**:「PR #N 已开 X 分钟仍无评审,外部评审服务可能未覆盖本仓库或未运行」,
   把 PR 链接给他;
2. **不要空转等待**,回主循环做下一个 task;
3. 需要人工 review 就人工——合并仍走正常流程(人 approve 后 `git-guard.sh merge-pr`)。

**绝不自己给自己 approve,绝不 `--admin` 绕过。** 没有裁决就是没有裁决。

## 没有外部评审服务的仓库

完全合理(个人项目、或团队本来就人工 review)。pilot 照常可用,只是裁决那一步由人承担:
开完 PR 直接说明「此 PR 需人工 review」,然后回主循环继续做事,别让 PR 悄悄挂死。
