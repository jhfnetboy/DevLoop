# Architecture Decision Records

序号递增。状态：`Accepted` / `Proposed` / `Deprecated` / `Superseded`。

| ADR | 决策 | 状态 |
|---|---|---|
| [0001](./0001-dsh-plugin-not-independent-runtime.md) | DevLoop 是 DSH 插件，不自建 Agent Runtime | Accepted |
| [0002](./0002-do-not-fork-dsh-core.md) | 不 fork DSH core，只走官方 Plugin / Bundle API | Accepted |
| [0003](./0003-reference-dsh-devflow-do-not-copy.md) | `dsh-devflow` 是参考实现，重新构建不整仓照搬 | Accepted |
| [0004](./0004-typescript-on-dsh-ecosystem.md) | TypeScript / Node，跟随 DSH 生态 | Accepted |
| [0005](./0005-capability-tiers-not-vendor-brands.md) | 按能力等级 T0–T3 路由，不按品牌绑定 | Accepted |
| [0006](./0006-deterministic-outer-loop.md) | 外层 Loop 是程序状态机，不是 LLM | Accepted |
| [0007](./0007-reviewer-is-not-implementer.md) | 实现者不能给自己最终审核；贵模型做 Plan / Review | Accepted |
| [0008](./0008-budget-circuit-breaker-first.md) | 预算与熔断是无人值守的前提，优先于更多阶段 | Accepted |
| [0009](./0009-file-backed-project-state.md) | 0.1 用 Markdown + JSON + Git 做项目状态，不上数据库 | Accepted |
