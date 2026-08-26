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
- usage 计数用 null-prototype 对象，避免 `__proto__` 任务 id 绕过 attempts/timeout
- 拒绝非有限 cost cap；escalate latch key 区分 `null` 与 `_`；空 task id 也触发 timeout/token 熔断

### 可能影响

- 尚无 `dsh plugin add` 入口；未写 `.devloop/`

## 0.1.2 — 2026-08-26

File-backed `.devloop/` state, exclusive LOCK, and the installable DSH plugin Service.

### 代码

- 新增 `persist.ts`：`STATE.json` 校验、无 `GOAL.md` 不武装、损坏状态安全停机
- 新增 `withStateLock`：跨进程互斥，过期 LOCK 可回收
- 新增 Cordis `DevloopService` + `cordis.patch.yml` + `templates/GOAL.md`
- 新增 persist / flow / service 测试，补齐 Plan 0.1.2 / 0.1.6 一对一覆盖
- LOCK takeover 文件名只允许数字 token；拒绝 `.devloop` 符号链接逃逸

### 可能影响

- 用户主动 `dsh plugin add` 后，DSH profile 会多一行 `devloop`；未放置 `.devloop/GOAL.md` 时 tick 保持 idle
- 尚不派真实 Worker，不改业务仓库代码

## 0.1.3 — 2026-08-26

README flowcharts for the 0.1 tick versus the 0.2 factory, plus an honest capability table.

### 文档

- 根 README 增加 mermaid：插件位置、0.1 tick（budget 在 `runTick`）、目标工厂图
- 写明 0.1 不能派 Worker、不能完成无人值守里程碑

### 可能影响

- 只改说明，不改调度语义

## 0.1.4 — 2026-08-26

External review on PR #3: loader no longer kills the workspace for prototype-reserved task ids; stale LOCK files can be stolen even if the recorded pid is still alive; lock results are a discriminated union.

### 可能影响

- `toString` / `__proto__` 任务 id 可以读回 STATE
- `kill -9` 后 pid 复用不再把工作区永远锁死（超过 30s 的 LOCK 可夺）
- `withStateLock` 返回 `{ ok, value }`，不再用 `'locked'` 字符串
