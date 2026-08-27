# Features

DevLoop 让一个人带着贵模型订阅和便宜 API，跑一支分层的 AI 工程队。贵模型当技术负责人和 Reviewer，便宜模型当执行工程师，程序 Loop 保证流程按规矩转、预算到点就停。

## 用户视角

### F1 说出目标，而不是盯着模型干活

用户写一份 GOAL（要什么、成功长什么样、约束、非目标）。之后系统按计划拆任务、派人、验收、汇报。用户只在架构 / 安全 / 目标冲突时被叫醒。

### F2 贵的订阅用在判断上

Claude / Codex 做规划、拆解、关键 Review。简单实现、测试、文档、summarize 默认不进贵模型。用户不必在每次改 README 时心疼 Max 额度。

### F3 便宜模型按任务扩容

确定性高的开发任务走 DeepSeek 等便宜 API，可并行多个 worktree。模型挂了可以换同等级的另一个，不必改工作流。

### F4 晚上能跑，也能停

用户可以留下「把 Milestone 2 做完，DeepSeek 预算 $10，Claude 只用于 Review」。系统按 tick 推进；触发熔断、三次失败升级、或需要人拍板时停止并留下状态，而不是默默烧 token。

### F5 进度可看、可恢复

随时能看到 Goal / Milestone / 任务队列 / 谁在跑 / 卡在哪。进程重启后从 `.devloop/` 接着干。

## 产品视角

### P1 Goal 驱动的工程状态机

对象是 Goal → Plan → Task → Run → Review → Merge → Progress。外层 Loop 是产品流程，不是聊天。禁止「持续开发直到完成」这种无界会话。

### P2 Task Contract

每个委派任务带：允许改的路径、禁止碰的路径、验收标准、时长与次数预算、建议 Tier。没有合同就不派工。

### P3 分层路由

T0 / T1 / T2 / T3 是产品角色。界面和配置谈角色，不谈「今天 DeepSeek 心情如何」。Review 等级必须高于实现等级。

### P4 质量闸门

没有 PASS 不能 merge。Worker 不能改 GOAL，不能推主干。高风险变更升级到人。

### P5 预算是功能，不是运维手册

用户能看见并配置任务超时、重试、日消费、kill switch。撞线后的行为是产品语义：停止、升级、或等待人。

## 技术视角

### T1 DSH 树外插件

`dsh-devloop` 以 bundle 安装进 profile，实现 `apply(ctx)` / Service。不改 Harness 源码。见 [ADR-0001](./adr/0001-dsh-plugin-not-independent-runtime.md)、[ADR-0002](./adr/0002-do-not-fork-dsh-core.md)。

### T2 可测试的纯规则核心

`decideNextAction`、budget、router 不依赖 LLM，单测即可锁住 24×7 行为。Agent 只出现在 adapter 边界。

### T3 文件权威状态

`.devloop/STATE.json` 为状态机权威；GOAL.md / PLAN.md / PROGRESS.md 给人。见 [ADR-0009](./adr/0009-file-backed-project-state.md)。

### T4 Backend 接口预留

0.2.1 把 `AgentBackend` 形状落地为 `run` / `cancel` / `health`，生产默认 `NoopBackend` 空跑。后续接 DSH headless、Codex exec、Claude CLI、OpenCode，不改 Loop。

### T5 参考而不耦合 winner

从 `dsh-devflow` 吸收 tick、fresh agent、worktree、stall watchdog 的思路，领域模型保持 Goal/Task，不引入需求池。见 [ADR-0003](./adr/0003-reference-dsh-devflow-do-not-copy.md)。
