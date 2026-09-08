# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dsh-devloop` — a **plugin for DeepSeek Harness (DSH)**, not a standalone agent and not a fork of DSH core (see `docs/adr/0001`, `0002`). It ships a Cordis `Service` that DSH loads into a profile via the bundle patch in `cordis.patch.yml`. Product thesis: expensive models plan and review, cheap models implement, and a deterministic program loop keeps the whole thing inside a budget.

Version 0.2.4. `README.md` has the slice-by-slice status table (0.2.5 = spawn Claude/Codex as T3; 0.3 = unattended 24h loop). Design rationale is in `docs/` and `docs/adr/`; read the relevant ADR before changing a decision it records.

## Commands

```bash
pnpm install --frozen-lockfile   # Node ^22.19.0 || >=24 (Node 23 is out of range)
pnpm test                        # vitest run, whole suite
pnpm exec vitest tests/budget.spec.ts   # one file
pnpm exec vitest -t 'name of test'      # one test by name
pnpm build                       # strict tsc -> lib/ (also runs via `prepare` on git install)
```

Run both `pnpm test` and `pnpm build` before opening a PR. Never edit `lib/` — it is generated.

## Architecture

The loop is deliberately split so that **policy is pure and effects are sequenced around it**.

- `loop.ts` — `decideNextAction(state)`: the entire outer-loop policy, a pure function of `LoopState`. **It must never call an LLM, touch the filesystem, or run git.** Priority order: killSwitch → goalCompleted → supervisor hold → high-risk escalate → failed → blocked → review → merge → delegate → plan → idle.
- `tick.ts` — `runTick(state, limits, now)`: wraps the decision with latching (a repeated work action becomes `idle` instead of re-firing) and `evaluateBudget`, which can rewrite any intended action into `stop`. Still pure.
- `budget.ts` — cost/attempt/timeout/no-progress circuit breaker over `BudgetUsage`.
- `service.ts` — the only place with effects. A timer calls `tick()`; each beat takes the cross-process lock, loads STATE, runs `runTick`, performs git work (worktree create for `delegate`, merge for `merge`), saves STATE, then releases the lock and hands `plan`/`delegate`/`review` to the `AgentBackend` **outside** the lock.
- `persist.ts` — `.devloop/` file state (`GOAL.md`, `STATE.json`, `LOCK`) plus `withStateLock` (link-based mutex with mtime heartbeats; a stale lock is stealable only after `LOCK_STALE_MS`).
- `worktree.ts` — all git: `prepareDelegateWorktree` (creates `.devloop/worktrees/<taskId>` on branch `devloop/<taskId>`, freezes `CONTRACT.json`, stamps `baseSha`), `mergeTaskWorktree`, `deleteMergedTaskBranch`.
- `backend.ts` / `dsh.ts` — the `AgentBackend` adapter boundary. Production default is `NoopBackend` (records only, spawns nothing). `agentBackend: 'dsh'` selects `DshHeadlessBackend`, which runs one-shot `dsh --profile headless "<prompt>"` in the worktree. `RecordingBackend` is a test double only.
- `router.ts` — tier routing and the reviewer rule. `config.ts` has a `routing` table (T0 local → T3 codex) but **dispatch does not read it yet**; every action still uses the same headless command.
- `index.ts` — the public surface; add new exports there.

### Invariants worth preserving

- **No PASS, no merge.** `merge` requires `status === 'merge_ready'` *and* `lastReviewVerdict` of `PASS`/`PASS_WITH_NOTES` (`reviewAllowsMerge`); anything else escalates.
- **The reviewer is never the implementer** and must outrank it (`assertReviewerAllowed`, ADR-0007). T3 work escalates to a human.
- **Merge is mechanical git only, local, never pushed.** It refuses a dirty tree, a detached HEAD, an in-progress merge, a branch still at its recorded `baseSha` (`empty_task`), or a missing `baseSha` (`unknown_base`). These failures persist a supervisor hold in STATE so duplicate-action detection can halt retries — see the `mergeHoldReason` path in `service.ts`.
- **Merge is not latched** (unlike plan/delegate/review) because its git effect happens after `runTick`.
- **Path safety is load-bearing**, not incidental: task ids are validated by `worktreeTaskToken`, and `.devloop/` must be a real directory resolving inside the workspace (symlink escapes halt the loop with `escaped_devloop`). Keep regression tests for these.
- The plugin is **idle until `<root>/.devloop/GOAL.md` exists as a regular file**; a bare `.devloop/` directory does not arm it.

## Style

ESM/NodeNext, strict TS with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. Two-space indent, single quotes, no semicolons, trailing commas. Source-to-source imports use `.js` extensions; tests import `.ts`. Domain types are `readonly` throughout and state transitions are written as new objects — do not introduce in-place mutation of `LoopState`. Prefer handling strict-null/index cases over widening with assertions.

## Tests

Vitest, `tests/**/*.spec.ts`. `tests/helpers.ts` has the temp-repo helpers that worktree/persist tests must use, with cleanup in `afterEach`. Add regression coverage for any fix touching budgets, locks, path validation, state persistence, or merge safety.

## Repo notes

- `DevLoop/`, `pstack/`, and `.tmp/` at the root are gitignored local scratch/reference clones — not part of this package.
- Reference implementations (`deepseek-harness`, `dsh-devflow`) are read for ideas only; nothing is vendored or copied (ADR-0003).

## Commits

Short imperative summaries stating the outcome, e.g. `Refuse empty PASS merges and persist a wedged abort.` Keep commits narrowly scoped; ship tests with behavioral changes. PRs should name the user-visible effect, the affected state transitions or safety invariants, and the verification commands.
