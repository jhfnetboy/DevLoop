# ADR-0007: Reviewer is not the implementer

**状态**: Accepted
**日期**: 2026-08-25

## 背景

用户的核心要求是贵模型做设计 / Review / 评估，便宜模型做基础开发。若实现模型给自己最终审核，分层没有意义。

## 决策

**实现者不能给本任务做最终审核。** `NO PASS = NO MERGE`。Worker 无 merge 权限。

默认矩阵：

| 实现 | 审核 |
|---|---|
| T0 | T1 或更高 |
| T1 | T3（Codex 常规 Review） |
| T2 | T3（Claude 关键 Review，必要时 Codex 交叉） |
| 架构 / 安全不确定 | 升级到人，或 Claude+Codex，禁止 Worker 自行拍板 |

`/review` 的输出只能是：

```text
PASS | PASS_WITH_NOTES | REWORK | REPLAN | BLOCKED
```

`/merge` 是机械流程（检查 PASS、rebase、测试、合入、删 worktree），可以由脚本 / T0 执行，不需要贵模型。

无人值守时不猜产品决策：架构不确定、安全高风险、破坏性 migration、GOAL 冲突 → 停下来升级，而不是继续改。

## 理由

- 这是用户付贵订阅的正当用途
- 与「模型绑定能力等级」一致：T3 卖判断，不卖 CRUD
- 防止便宜模型用自信的错误通过自己的 diff

## 后果

**正面**：
- 质量闸门清晰
- merge 可以完全自动化，只要 Review 契约被遵守

**负面/权衡**：
- 吞吐受 T3 额度限制；因此 Review 也要按风险分级，避免所有 T0 都打到 Claude
- Claude Max 接入 DSH 未验证前，Review 可能走外部 CLI adapter
