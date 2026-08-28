# Release 0.2.4

Mechanical merge after Review PASS. Tag `v0.2.4` and the GitHub Release are created **after** this commit is on `main`; steps: [Deploy.md](./Deploy.md).

Package version: **0.2.4**. This document is the release note, not a second semver.

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
| 0.2.4 merge | this | Review PASS → `git merge` task branch, delete worktree, mark `done` |

Host-side checks (`dsh plugin add`, `--dump-config`) are listed in [UserCaseTest.md](./UserCaseTest.md).

## Honest limits

- No Codex / Claude CLI adapter (Plan **0.2.5 — not started**).
- Worker output does not write task status back into STATE. PASS / REWORK is operator-driven (`lastReviewVerdict` on the task). The verdict is not bound to a commit SHA; later commits on the task branch can land under a stale PASS.
- Merge does not push. Conflicted merges abort and retry next tick.
- No unattended milestone loop (**0.3**) and no UI (**0.4**).
- npm registry: not published in this cut unless `npm whoami` works. Install from GitHub or the Release tarball. See [Install.md](./Install.md).

Progress and the path to 0.3: live [README on `main`](https://github.com/jhfnetboy/DevLoop/blob/main/README.md).
