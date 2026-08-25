# Changes

## 0.1.0 — 2026-08-25

文档与 DSH 插件骨架。范围仅限 0.1：把已确认的技术决策落成 ADR，并把可安装的插件和可测试的调度核心立起来。

### 文档

- 新增 `docs/Solution.md`：从原始对话提取需求与约束（信息源头）
- 新增 `docs/Design.md`、`docs/Features.md`、`docs/Plan.md`、`docs/CONTEXT.md`
- 新增 `docs/adr/0001`–`0009`：以文末决策为准的架构记录

### 代码

- 新增 DSH bundle 插件 `dsh-devloop`（`cordis.patch.yml` + Cordis Service）
- 新增确定性 Loop、Budget 熔断、Tier 路由、`.devloop/` 持久化
- 新增 vitest 单测覆盖上述纯函数与 tick 空转

### 可能影响

- 尚不派真实 Worker，不影响任何业务仓库的代码，除非用户主动 `dsh plugin add` 并在项目里放置 `.devloop/`
- 安装后 DSH profile 会多一行 `devloop` 插件；未配置 GOAL 时 tick 保持 idle

### 构建与测试

```bash
pnpm install
pnpm test
pnpm build
```

安装到 DSH 见仓库根 README。

## 0.1.1 — 2026-08-25

自我 review + 另一模型挑战 review 后的熔断修正，仍不派真实 Worker。

### 代码

- tick 对相同工作动作加闩锁，避免每拍重写 `STATE.json`
- `recordAction` 累计 attempts / reviewCycles / taskStartedAt
- `STOP` 置 killSwitch 并停表；插件 dispose 后不再写盘
- 无 `GOAL.md` 视为未武装；损坏的 `STATE.json` 安全停机而不抛死循环
- 临时文件名带 pid，降低并发 rename 碰撞

### 可能影响

- 已有 `.devloop/` 但没有 `GOAL.md` 的目录不再被 tick
- 第一次 `plan`/`delegate` 之后会保持 lastAction，直到超时熔断或外部改状态

## 0.1.2 — 2026-08-25

External Codex CLI review on PR #1 returned REQUEST_CHANGES. Applied the four P2 items without re-judging them: rework retries are not latched, persisted usage/tasks/actions are fully validated, `failed` queues escalate, high-risk ready tasks escalate.

## 0.1.3 — 2026-08-25

Full pipeline tests and Plan/Features 1:1 coverage. Still no real Worker spawn.

### 测试

- 新增 `tests/flow.spec.ts`：GOAL 武装 → plan → delegate → review → merge → done/stop，以及 rework 重试与预算停机落盘
- 新增 `tests/one-to-one.spec.ts`：Plan 0.1.2–0.1.7 与 Features 关键闸门一对一
- 新增 `tests/service.spec.ts`：Cordis Service 未武装空转、武装后闩锁、disabled 不启动
- 新增 `docs/UserCaseTest.md`：用户场景到 spec 的对照，供人工验收

### 可能影响

- 只增加测试与用例文档，不改变 0.1 调度语义
- 安装与 tick 行为与 0.1.2 相同

### 构建与测试

```bash
pnpm install
pnpm test
pnpm build
```

## 0.1.4 — 2026-08-25

External Codex CLI review on PR #1 returned REQUEST_CHANGES. Applied the four items without re-judging them: running-task timeouts fire without waiting for another `delegate`, usage JSON must include every hard-cap field, high-risk work escalates before review/merge, ticks take a cross-process `.devloop/LOCK`.

### 可能影响

- 损坏或截断的 `STATE.json` 会安全停机，包括缺 `costUsdDay` / `costUsdSession` / `parallelWorkers`
- `running` 超时后会 `stop`/`budget`，即使外层动作是 idle
- 高风险 `review_pending` / `merge_ready` 不再直接 review/merge
- 同一 root 上第二个进程的 tick 会跳过并打 log，直到锁释放

## 0.1.5 — 2026-08-25

External Codex CLI review on PR #1 returned REQUEST_CHANGES. Applied the five P2 items without re-judging them: failed tasks escalate before normal work, token caps are per-task, stale LOCK is claimed by rename-then-exclusive-create, task records and nonnegative budget fields fail closed.

## 0.1.6 — 2026-08-25

External Codex CLI review on PR #1 returned REQUEST_CHANGES. Applied the three P2 items without re-judging them: missing `lastDispatchStatus` does not latch, persisted `LoopAction` is a full discriminated union, locks are stolen only when the holder pid is dead.

## 0.1.7 — 2026-08-25

External Codex CLI review on PR #1 returned REQUEST_CHANGES. Applied without re-judging: lock ownership is published with `link`, failed/blocked queues idle instead of dispatching other work, review caps apply to rework delegates, prototype-reserved task ids fail closed, `maxSameAction` is capped at 20.

## 0.1.8 — 2026-08-25

External Codex CLI review on PR #1 returned REQUEST_CHANGES. Applied without re-judging: stale-lock takeover checks the renamed body still matches the observed dead owner, `EPERM` from `kill(pid,0)` is treated as live, duplicate task ids fail closed.

## 0.1.9 — 2026-08-25

External Codex CLI review on PR #1 returned REQUEST_CHANGES. Applied without re-judging: usage counters use own-property lookups, leftover `taskStartedAt` entries do not timeout missing tasks, and budget stops attribute the supervisor hold to the timed-out task.

## 0.1.10 — 2026-08-25

External Codex CLI review on PR #1 returned REQUEST_CHANGES. Applied without re-judging: parallel-worker cap is derived from `running` tasks, and persisted state requires `supervisor` plus `updatedAt`.

