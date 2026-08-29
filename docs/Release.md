# Release 0.2.5

Optional Claude CLI / Codex CLI T3 adapters. Tag `v0.2.5` and the GitHub Release are created **after** this commit is on `main`; steps: [Deploy.md](./Deploy.md).

Package version: **0.2.5**. This document is the release note, not a second semver.

## What is in this version

Stacked merges already on `main`, plus this slice:

| Slice | PR | Ships |
|---|---|---|
| 0.1 docs | #2 | Design, Features, Plan, ADR |
| 0.1 core | #4 | `decideNextAction`, budget, router, `runTick` |
| 0.1 persist / plugin | #3 | `.devloop/STATE.json`, LOCK, Cordis Service, `dsh plugin add` |
| 0.2.1 AgentBackend | #5 | `run` / `cancel` / `health`; production default `NoopBackend` |
| 0.2.2 worktree | #6 | `.devloop/worktrees/<taskId>`, `CONTRACT.json`, LOCK heartbeat |
| 0.2.3 headless | #7 | `agentBackend: dsh` → `dsh --profile headless`; default stays `noop` |
| 0.2.4 merge | #11 | Review PASS → `git merge` task branch, delete worktree, mark `done` |
| 0.2.5 T3 CLI | this | Optional `agentBackend: claude` / `codex`; default stays `noop` |

Host-side checks (`dsh plugin add`, `--dump-config`) are listed in [UserCaseTest.md](./UserCaseTest.md).

## Honest limits

- CLI adapters do not parse PASS / REWORK from stdout. `lastReviewVerdict` is still operator-driven (or whatever writes STATE).
- Merge does not push. Conflicted merges abort and retry next tick.
- One `agentBackend` per host; this slice does not route `contract.tier` to different CLIs.
- T3 CLIs refuse to run at the workspace root. `plan` uses a reserved `_loop-plan` worktree plus read-only / plan permission flags. That id is outside the user task-token alphabet.
- No unattended milestone loop (**0.3**) and no UI (**0.4**).
- npm registry: not published in this cut unless `npm whoami` works. Install from GitHub or the Release tarball. See [Install.md](./Install.md).

Progress and the path to 0.3: live [README on `main`](https://github.com/jhfnetboy/DevLoop/blob/main/README.md).
