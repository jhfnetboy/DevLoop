# Release 0.3.0

Bounded autonomous engineering loop: structured model results, deterministic state transitions, host-enforced write scope, SHA-bound independent review, durable recovery, and role/tier routing. Tag `v0.3.0` and the GitHub Release are created **after** this commit is on `main`; steps: [Deploy.md](./Deploy.md).

Package version: **0.3.0**. This document is the release note, not a second semver.

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
- No operator UI (**0.4**).
- npm registry: not published in this cut unless `npm whoami` works. Install from GitHub or the Release tarball. See [Install.md](./Install.md).
