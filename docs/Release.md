# Release 0.4.2

Bounded autonomous engineering loop: structured model results, deterministic state transitions, host-enforced write scope, SHA-bound independent review, durable recovery, and role/tier routing. Tag `v0.4.2` and the GitHub Release are created **after** this commit is on `main`; steps: [Deploy.md](./Deploy.md).

Package version: **0.4.2**. This document is the release note, not a second semver.

## New in 0.4.2

A patch: no config, no state field, no behaviour a running loop can notice
changes. Upgrading from 0.4.1 is a drop-in.

| Change | PR | Ships |
|---|---|---|
| Runnable answers | [#29](https://github.com/jhfnetboy/DevLoop/pull/29) | `devloop status` prints each `answer` as the absolute invocation of the copy that was run, with the project root filled in, so it pastes as printed. A test feeds every printed line back to the CLI |
| Prices | this | `priceUsage`, `peakBand`, `toUsd` exported: DeepSeek V4.1 Flash prices (CNY, peak/off-peak), with `deepseek-v4-pro` billed as Flash during the transition. [Pricing.md](./Pricing.md) |
| Research | this | [Research-dsh-devtools.md](./Research-dsh-devtools.md): what `nzl153/dsh-devtools` does and what to take from it |

The prices are a library with **no caller yet**, and that is deliberate rather
than unfinished: pricing needs input split by cache hit and miss plus output,
and `BackendResult` carries a single token total. Nothing is estimated from it —
an unpriced model or a pre-effective-date dispatch returns a reason, not a
number, and CNY is never converted to the USD caps without an operator-supplied
rate.

This is not the 0.5 operator surface, and nothing here should be read as it.

## New in 0.4.1

Three things the loop was missing, found by reading it against two published
long-running-agent designs ([#24](https://github.com/jhfnetboy/DevLoop/pull/24)):

| Change | PR | Ships |
|---|---|---|
| Gates | [#21](https://github.com/jhfnetboy/DevLoop/pull/21) | A halt is a question with answers, not an error code: `devloop answer <retry\|review\|accept\|stop>` |
| Host-run acceptance | [#22](https://github.com/jhfnetboy/DevLoop/pull/22) | Operator-configured argv checks run in the task worktree **before** a reviewer is paid. Off by default |
| Quota after a result | [#23](https://github.com/jhfnetboy/DevLoop/pull/23) | A dispatch no provider ever saw is refunded, and counted separately so a broken route is named rather than timed out |
| Quick start | [#25](https://github.com/jhfnetboy/DevLoop/pull/25) | README leads with running it; `devloop` is spelled as a path, because nothing puts it on `PATH` |

Both `acceptance` and the gate answers are operator decisions: a model never
chooses what the host executes, and `answer stop` is now recorded rather than
merely printed, so a halt nobody has read and one somebody declined are
distinguishable in `.devloop/`.

New config: `acceptance`, `acceptanceTimeoutMinutes` (**per command**, not for
the list), `budget.maxRefusedDispatches` (default 2). New state fields
`usage.refusedDispatches` and `acknowledged`; states written by 0.3.0 load
unchanged.

A minor, not a patch: `devloop answer`, host-run acceptance and the new budget
circuit are new surface. Upgrading from 0.3.0 changes no behaviour on its own —
`acceptance` defaults to empty, so nothing runs until an operator lists
commands — but the surface is new, and the version should say so. The deferred
list that used to be called `V0.4-TODO.md` is now
[`V0.5-TODO.md`](./V0.5-TODO.md); it was renamed rather than reset, because the
reasons attached to each deferred item are the point of it.

Known, and written down rather than hidden: the gate prints `devloop answer
retry`, which is the one line an operator cannot paste, because nothing links a
package's own `bin` onto `PATH`. Tracked in
[`V0.5-TODO.md`](./V0.5-TODO.md) with the three candidate fixes.

## What is in this version

Merges already on `main` through 0.2.6 (PR #14), plus this slice:

| Slice | PR | Ships |
|---|---|---|
| 0.1 docs | #2 | Design, Features, Plan, ADR |
| 0.1 core | #4 | `decideNextAction`, budget, router, `runTick` |
| 0.1 persist / plugin | #3 | `.devloop/STATE.json`, LOCK, Cordis Service, `dsh plugin add` |
| 0.2.1 AgentBackend | #5 | `run` / `cancel` / `health`; production default `NoopBackend` |
| 0.2.2 worktree | #6 | `.devloop/worktrees/<taskId>`, `CONTRACT.json`, LOCK heartbeat |
| 0.2.3 headless | #7 | `agentBackend: dsh` → `dsh --profile headless`; default stays `noop` |
| 0.2.4 merge | #11 | Review PASS → `git merge` task branch, delete worktree, mark `done` |
| 0.2.5 T3 CLI | #12 | Optional `agentBackend: claude` / `codex`; default stays `noop` |
| 0.2.6 hardening | #14 | Host-side task commits, safer CLI argv, durable commit-failure hold |
| 0.3 autonomous | this | Structured results, automatic transitions, host scope/SHA gates, event recovery, named-provider routing |

Host-side checks (`dsh plugin add`, `--dump-config`) are listed in [UserCaseTest.md](./UserCaseTest.md).

## Honest limits

- This release advances plan → delegate → review → merge from validated `<devloop_result>` envelopes. Arbitrary prose and missing envelopes stop safely; operators must not edit `STATE.json` to imitate model results.
- A malformed CLI result gets one protocol-only repair attempt; delegate repair is forced into Claude `plan` or Codex `read-only` mode. DSH delegate results do not retry because that adapter has no enforceable read-only mode. A second malformed result stops safely.
- Merge does not push. Conflicted merges abort and retry next tick.
- `agentBackend: routed` sends plan to `plannerRoute`, delegate to `routing[contract.tier]`, and review to an independent `reviewerRoute`; identical implementer/reviewer identities fail closed. The default remains `noop`.
- Native Harness providers use `backend: subagent:<provider>` and require the Harness `agents`, agent-loop, and `subagents` services plus that named provider. Provider configuration chooses the actual model; the route `model` is descriptive and must match it.
- T3 CLIs refuse to run at the workspace root (null cwd **or** cwd equal to the workspace). `plan` and `review` use read-only / plan permission flags; only `delegate` gets write access (Claude prompt after `--`; Codex `--add-dir` points at the linked gitdir). After a started delegate, the **host** commits dirty task files on `devloop/<taskId>` only, with hooks disabled. `plan` uses a reserved detached `_loop-plan` worktree (does not create or delete `devloop/_loop-plan`). Plan stdout is copied to `.devloop/PLAN.md`; review stdout to `.devloop/REVIEW.md`; whitespace-only stdout removes a stale note.
- `STATE.json` is an atomic snapshot; `EVENTS.jsonl` is the append-only, monotonic recovery authority after a torn or missing snapshot.
- Token/cost melt the circuit only when the backend fills `AgentRunResult`; otherwise the loop uses wall-clock `lastProgressAt`. Session cost resets after the first successful STATE persist of this process; daily cost resets at UTC midnight.
- The automated E2E uses a scripted provider, and the release candidate also completed a real-provider plan → implement → exact-SHA review → merge run without operator state edits.
- No operator UI (**0.5**).
- npm registry: `@jhfnetboy/dsh-devloop@0.4.2` is published. GitHub and the Release tarball remain supported. See [Install.md](./Install.md).
