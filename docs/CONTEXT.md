# DevLoop 领域词汇表

> 本文件是项目的唯一术语真相来源。代码、文档、对话使用这里的词。

## 术语表

### Goal / 目标
**定义**：用户或 T3 Supervisor 写下的项目级成功条件（要什么、约束、非目标）。
**区别于**：DSH 包 `@deepseek-ai/dsh-goal` 里的 session Goal（单次 Agent 会话的当前目标）。项目 Goal 活在 `.devloop/GOAL.md`。
**代码中的体现**：`GoalDocument` / `.devloop/GOAL.md`

### Plan / 计划
**定义**：由 Goal 拆出的里程碑与任务清单，`/plan` 的产出。
**区别于**：一次 LLM 的思维链。Plan 是文件，Worker 只读。
**代码中的体现**：`.devloop/PLAN.md`、`TASKS.json`

### Task / 任务
**定义**：带 Tier、风险、验收、路径范围的有界工作单元。
**区别于**：DSH 里一次 headless job、或 dsh-devflow 的 requirement 池条目。我们不使用「需求池」作为主对象。
**代码中的体现**：`Task` in `src/types.ts`

### Task Contract / 任务合同
**定义**：派工时冻结的约束：允许路径、禁止路径、验收、时长与次数预算、指定 Tier。
**区别于**：口头 prompt。「实现这个」不是合同。
**代码中的体现**：`TaskContract`

### Tier / 能力等级
**定义**：T0 Mechanical、T1 Worker、T2 Senior、T3 Tech Lead。路由键。
**区别于**：模型品牌名。DeepSeek / Claude 是 realization，不是 Tier。
**代码中的体现**：`ModelTier`

### Loop / 外层循环
**定义**：程序状态机，每次 tick 一次状态转换。
**区别于**：DSH Agent Loop（模型在一次会话里调工具的内层循环）。
**代码中的体现**：`decideNextAction`

### Tick / 节拍
**定义**：Loop 的一次执行：读状态 → 决定动作 →（0.1 只记录）→ 写回 → 结束。
**区别于**：一次完整的 plan→merge 流水线。
**代码中的体现**：`DevloopService.tick`

### Worker / 工人
**定义**：执行 Task Contract 的廉价 Agent（默认 DSH + DeepSeek）。
**区别于**：Supervisor。Worker 不改 Goal、不 merge、不做最终 Review。

### Supervisor / 主管
**定义**：T3 角色，做 `/plan`、关键 Review、失败诊断。默认 Codex 偏调度，Claude 偏架构与关键 Review。
**区别于**：DSH 进程本身。Supervisor 是模型角色，Harness 是运行时。

### Reviewer / 审核者
**定义**：对某次实现给出 PASS / REWORK / … 的更高 Tier。
**区别于**：实现者。同一模型实例不能审自己的产出。

### Budget / 预算
**定义**：任务、会话、项目上的硬限制（时间、次数、token、美元、无进展）。
**区别于**：模型自己的 max_tokens 参数。Budget 是插件策略。

### Circuit breaker / 熔断
**定义**：撞线后停止或升级，而不是继续派工。
**区别于**：单次 API 重试。
**代码中的体现**：`evaluateBudget`

### Worktree / 工作树
**定义**：一个 Task 的隔离 git checkout。Worker 只在这里写。
**区别于**：主工作区。0.1 只预留字段，不创建 worktree。

### Winner / 参考实现
**定义**：社区插件 `dsh-devflow`，作为「已经跑通 DSH 插件层流水线」的参考。
**区别于**：本项目的上游依赖。我们不 fork、不 vendoring 其产品逻辑。

### Harness / DSH
**定义**：DeepSeek Harness，Agent Runtime。
**区别于**：DevLoop。Harness 不知道 Milestone / Task Contract。

## 核心业务规则

- Worker 永远不能修改 Goal。
- 实现者不能给自己最终审核。
- `NO PASS = NO MERGE`。
- `decideNextAction` 不得调用 LLM。
- 无人值守时不猜产品决策，升级给人。
- 系统绑定 Tier，不绑定模型品牌。
- 一次 tick 最多一次状态转换。

## 决策记录（链接）

- [ADR-0001](./adr/0001-dsh-plugin-not-independent-runtime.md) — 做 DSH 插件，不自建 Runtime
- [ADR-0002](./adr/0002-do-not-fork-dsh-core.md) — 不 fork DSH core
- [ADR-0003](./adr/0003-reference-dsh-devflow-do-not-copy.md) — winner 只作参考
- [ADR-0004](./adr/0004-typescript-on-dsh-ecosystem.md) — TypeScript，跟随 DSH Node 版本
- [ADR-0005](./adr/0005-capability-tiers-not-vendor-brands.md) — T0–T3 路由
- [ADR-0006](./adr/0006-deterministic-outer-loop.md) — 外层 Loop 是程序
- [ADR-0007](./adr/0007-reviewer-is-not-implementer.md) — 审核分离
- [ADR-0008](./adr/0008-budget-circuit-breaker-first.md) — 熔断优先
- [ADR-0009](./adr/0009-file-backed-project-state.md) — 0.1 文件状态
