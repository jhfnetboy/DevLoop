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

## 0.2.1 — 2026-08-26

AgentBackend dispatch after the state lock is released. No worker process, no worktree.

### 代码

- 新增 `AgentBackend`：`run` / `cancel` / `health`
- 生产默认 `NoopBackend`（不攒历史）；`RecordingBackend` 只给测试用
- `DevloopService` 在 LOCK 外对 plan / delegate / review 调用 `dispatchTick`；merge 仍只写 STATE
- Task Contract 禁止 `.devloop/`（含 STATE.json）

### 可能影响

- tick 先写 STATE 再派 backend，是 at-most-once：backend throw / `failed` 只打独立日志，不改已写入的状态，也不重试（后续 tick 被 latch 成 idle）
- 仍不 spawn DeepSeek / Claude / Codex，不创建 git worktree

## 0.2.2 — 2026-08-26

Delegate creates a git worktree and writes the frozen Task Contract. Still no worker process.

### 代码

- 新增 `prepareDelegateWorktree`：在 `.devloop/worktrees/<taskId>` 建 worktree，分支 `devloop/<taskId>`
- 合同写到 worktree 内 `.devloop/CONTRACT.json`，并写 `.devloop/.gitignore`=`*`，避免 `git add -A` 把合同带进 merge
- task id 必须是单路径段；拒绝已存在但不是 worktree 的目录、符号链接 pool
- worktree 准备在 LOCK 内、latch 之前；失败不写 STATE，下一拍可重试
- 复用 worktree 时用 `symbolic-ref` 认分支；detached HEAD 会 `switch` 回去
- LOCK 在临界区内每 5s `utimes` 心跳，git 准备超过 30s 也不会被第二把锁夺走

### 可能影响

- 目标仓库必须是 git toplevel；非 git 目录的 delegate 不 latch，修好仓库后下一拍会再试
- backend 派发失败才是 at-most-once（已开工/已花钱）；准备失败不是
- 仍不 spawn DeepSeek / Claude / Codex，不合入、不删 worktree

## 0.2.3 — 2026-08-26

DSH headless one-shot on plan / delegate / review. Default stays Noop so existing installs do not spawn.

### 代码

- 新增 `DshHeadlessBackend`：`execFile` 跑 `dsh --profile headless "<task>"`，cwd 为 worktree（无则 workspace）
- `Config.agentBackend`：`'noop' | 'dsh'`，默认 `'noop'`；`createBackend()` 按此项选择，cordis 两参构造即可切到 headless
- `AgentRunInput.signal`：派发与 `budget.taskTimeoutMinutes` 竞速，超时 abort；`stop()` 也会 abort 在途 run
- `taskTimeoutMinutes` 只限单次尝试；`taskLifetimeMinutes` 默认 `timeout × maxTaskAttempts`，管整个任务墙钟。第一次尝试跑满 45 分钟仍可再派，不会立刻 killSwitch
- latch 键带上 `task.attempts` / `reviewCycles`，ready 重新武装且 attempts++ 会再派一次
- `review` 若已有 `.devloop/worktrees/<taskId>` 则在该 worktree 派工，不在主工作区 spawn

### 可能影响

- 默认仍不 spawn；要真派工需在 DSH 插件配置里设 `agentBackend: dsh`，且本机有 `dsh`
- backend 失败仍 at-most-once；超时只松开 `busy` 并 abort 子进程，不改已 latch 的 STATE
- 单次尝试用满 `taskTimeoutMinutes` 之后，`maxTaskAttempts` 仍生效；整段任务墙钟看 `taskLifetimeMinutes`
- 0.2.4 之前 merge 仍只写 STATE，不合入、不删 worktree

### Packaging — 2026-08-28

No scheduler behavior change. `package.json` version aligned to **0.2.3** (was still `0.1.0` after the stacked merges). Added `docs/Install.md`, `docs/Release.md`, `docs/Deploy.md`. GitHub tag `v0.2.3` is cut after this lands on `main`. npm registry is not part of this cut.

Possible impact: Git / GitHub installs report `0.2.3`. Plan 0.2.4 (mechanical merge) and 0.2.5 (T3 CLI) are still not done.

Quote `github:…#v0.2.3` in install commands: zsh glob-expands `#` and prints `no matches found`.

### Docs — 2026-08-28

Docs only; **no package version bump** (still 0.2.3 — bumping to 0.2.4 would collide with Plan 0.2.4 mechanical merge).

README records the product target (Claude CLI / Codex CLI / DSH Flash-Pro / 24h loop) versus shipped **v0.2.3**. **0.2.4 is not done.** Path: 0.2.4 → 0.2.5 → 0.3 (0.4 is UI, later).

## 0.2.4 — 2026-08-28

Mechanical merge after Review PASS. No T3 CLI, no unattended 24h loop.

### 代码

- `Task.lastReviewVerdict` 可选；`merge_ready` 且 `PASS` / `PASS_WITH_NOTES` 才 `merge`，否则 escalate `no_review_pass`
- `mergeTaskWorktree`：把 `devloop/<taskId>` 合进工作区 HEAD（不 push）；合入前拒绝 detached HEAD、已有 MERGE_HEAD、主工作区已跟踪脏文件、脏 task worktree、错误分支；`Task.baseSha`（delegate 时写入 STATE，40 hex）与任务分支 tip 相同则 escalate `empty_task`，缺 SHA 则 `unknown_base`；abort 失败则 `merge_wedged`；冲突则只 abort **本次** merge；任务分支留到 STATE 写完再删
- 合入成功后删除 worktree 与任务分支，并把该任务标为 `done`；worktree 已删但任务分支还在时仍会合入该分支
- merge 不进 `AgentBackend`；git 失败仍写入该拍 STATE（任务保持 `merge_ready`），连续失败会撞 `duplicate_action` 熔断；`empty_task` / `merge_wedged` 则写入 `supervisor` 停给主管；成功后才标 `done` 并删分支
- 高风险 `merge_ready` 仍先 escalate `security_high_risk`

### 可能影响

- 工作区必须是 git toplevel，且存在已登记的 task worktree，否则 merge 失败、不 latch
- 无 Review PASS 的 `merge_ready` 会停给主管，不会合入
- Worker PASS/REWORK 仍需写进 `STATE.json`（CLI adapter 不解析 verdict 回写 STATE）

Possible impact: operators who previously marked `merge_ready` without `lastReviewVerdict` will see `no_review_pass` instead of a STATE-only merge. GitHub installs of this slice report `0.2.4`.

## 0.2.5 — 2026-08-29

Optional Claude CLI / Codex CLI T3 adapters. Default stays `noop`. No unattended 24h loop.

### 代码

- `Config.agentBackend`：`'noop' | 'dsh' | 'claude' | 'codex'`，默认仍 `'noop'`
- `ClaudeCliBackend`：`claude -p "<prompt>"`，cwd 为 worktree（无则 workspace）
- `CodexCliBackend`：`codex exec "<prompt>"`，同样走 `execFile`、转发 AbortSignal
- `createBackend()` 按配置选择；生产路径不经过 `RecordingBackend`

### 可能影响

- 默认仍不 spawn；要 T3 CLI 需设 `agentBackend: claude` 或 `codex`，且本机有对应命令
- CLI 退出码非 0 记 `failed`，与 0.2.3 dsh 一样不重试；不把 stdout 解析成 PASS/REWORK
- Loop 纯函数未改

Possible impact: hosts without `claude` / `codex` on PATH stay on `noop` or `dsh`. GitHub installs of this slice report `0.2.5`.
