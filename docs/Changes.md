# Changes

## 0.1.0 — 2026-08-25

文档与 ADR。范围仅限 0.1 的架构记录；插件代码在后续 stacked PR 落地。

### 文档

- 新增 `docs/Solution.md`：从原始对话提取需求与约束（信息源头）
- 新增 `docs/Design.md`、`docs/Features.md`、`docs/Plan.md`、`docs/CONTEXT.md`
- 新增 `docs/adr/0001`–`0009`：以文末决策为准的架构记录
- 新增 `docs/UserCaseTest.md`：用户场景到后续 spec 的对照

### 可能影响

- 只增加设计文档，不安装插件，不改运行时

## 0.1.1 — 2026-08-26

Deterministic loop core without file persistence or DSH Service.

### 代码

- 新增 `decideNextAction`、budget 熔断、tier router、`runTick`
- 新增 vitest 覆盖 Plan 0.1.3–0.1.5 / 0.1.7

### 可能影响

- 尚无 `dsh plugin add` 入口；未写 `.devloop/`
