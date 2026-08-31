# Plan

按阶段推进。每阶段一个分支、一个 PR，不把前一阶段自行合进 main。新阶段从最新阶段分支拉出。

**当前分支是 0.3（无人值守循环），stacked on 0.2.6（PR #14）。**

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

0.2 把「记录下一步」变成「真的派工」。仍不接 Web UI。每项一个 stacked PR，从 `main`（0.1 已合入）拉出。

| ID | 事项 | 验收 | 状态 |
|---|---|---|---|
| 0.2.1 | `AgentBackend` 接口 + Noop 空跑 | `run` / `cancel` / `health` 有单测；plan/delegate/review 在释放 LOCK 之后才交给 backend；生产默认 `NoopBackend`；不 spawn、不建 worktree | **Done** (PR #5) |
| 0.2.2 | git worktree + 写入 Task Contract | delegate 时隔离目录存在合同文件 | **Done** (PR #6) |
| 0.2.3 | DSH headless 实现 `AgentBackend.run` | 覆盖 `createBackend()`（cordis 只传 ctx+config）；`agentBackend: dsh` 真派一次 `dsh --profile headless`；默认 `noop` 不 spawn；超时 abort；不改 Loop 纯函数 | **Done** (PR #7, tag v0.2.3) |
| 0.2.4 | 机械 `/merge` 脚本 | 无 Review PASS 不能合；合完删 worktree | **Done** (PR #11) |
| 0.2.5 | Codex / Claude CLI 作为 T3 最小接线 | 可选 adapter；生产默认仍是 `noop` / `dsh`，不经过 `RecordingBackend` | **Done** (PR #12) |
| 0.2.6 | T3 harden (Codex RC on #12) | 宿主 commit、Claude `--` 无 Bash 通道、Codex gitdir 指针、空 stdout 清笔记 | **Open** (PR #14) |

**本阶段明确不做**：Web UI、OpenCode adapter、LiteLLM、日预算面板。

## Milestone 0.3 — Unattended scheduler

**This slice.** Continuous `setInterval` tick (already in 0.2), role/tier routing, one-shot dispatch (next tick waits; at most one in flight), optional token/cost signals, `.devloop/PROGRESS.md`.

- `devloop run` 式持续 tick（程序循环）
- 一次派发一名 fresh agent；STATE 有新阶段时下一拍继续调度
- plan / review 独立路由；delegate 按 `contract.tier` 选 worker，禁止同一 backend+model 自审
- 熔断接入真实 token / 成本信号（能拿到多少算多少，拿不到用墙钟）
- 进度汇总写入 PROGRESS.md

**边界**：本阶段不把 PLAN 输出解析为任务，也不把 Review stdout 解析为 PASS / REWORK。没有外部集成更新 STATE 时，0.3 只保证调度器持续、安全地运行，不承诺端到端自动完成里程碑。

## Milestone 0.4 — Operator surface

**未开始。** 在 0.3 的无人值守循环能跑之后。不是到达产品目标的前置条件。

- 最小 Web 或 DSH sidebar 入口（需要时再借鉴 dsh-devflow 的挂载方式）
- 人类等待队列
- 日预算面板

## 阶段纪律

- 缩小范围：只实现当前表格里的项
- 测不过不更新 Changes 为完成
- 参考 `dsh-devflow` 时只记思路，不把他们的阶段机拷进本仓库
