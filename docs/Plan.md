# Plan

按阶段推进。每阶段一个分支、一个 PR，不把前一阶段自行合进 main。新阶段从最新阶段分支拉出。

0.1 只做「能安装的 DSH 插件 + 可测试的调度核心」。不在本阶段接真实 Worker 进程。

## Milestone 0.1 — Plugin scaffold and deterministic core

**目标**：插件能装进 DSH profile；Loop / Budget / Router / 文件状态有单测；文档与 ADR 齐。

| ID | 事项 | 验收 |
|---|---|---|
| 0.1.1 | 文档：Solution / Design / Features / ADR / 术语 | 与文末技术决策一致 |
| 0.1.2 | npm 包 `dsh-devloop`：`dsh.bundle` + `cordis.patch.yml` + Service | `pnpm build` 产出可被 DSH 加载的入口 |
| 0.1.3 | `decideNextAction` 纯函数 | 单测覆盖 STOP / plan / delegate / review / merge / escalate |
| 0.1.4 | Budget / circuit breaker | 单测覆盖超时、次数、重复动作、日预算 |
| 0.1.5 | Tier router + reviewer 必须高于 implementer | 单测覆盖升级路径与非法自审 |
| 0.1.6 | `.devloop/` 读写 | 无 GOAL 时 tick 空闲；有 STATE 时写下一步 |
| 0.1.7 | README 安装到 DSH | 本地 `pnpm test` 通过 |

**本阶段明确不做**：真实 `dsh --profile headless` 派工、worktree 池、merge 脚本、Web UI、OpenCode adapter。

## Milestone 0.2 — Worker adapter and worktree

- DSH headless backend 实现 `AgentBackend.run`
- Task Contract 写入 worktree
- 机械 `/merge` 脚本（仍要求 Review PASS）
- Codex / Claude CLI 作为 T3 adapter 的最小接线

## Milestone 0.3 — Unattended loop

- `devloop run` 式持续 tick（程序循环）
- 自动泵：一任务一 fresh agent
- 熔断接入真实 token / 成本信号（能拿到多少算多少，拿不到用墙钟）
- 进度汇总写入 PROGRESS.md

## Milestone 0.4 — Operator surface

- 最小 Web 或 DSH sidebar 入口（需要时再借鉴 dsh-devflow 的挂载方式）
- 人类等待队列
- 日预算面板

## 阶段纪律

- 缩小范围：只实现当前表格里的项
- 测不过不更新 Changes 为完成
- 参考 `dsh-devflow` 时只记思路，不把他们的阶段机拷进本仓库
