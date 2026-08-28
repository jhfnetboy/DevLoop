# Release 0.2.3

First public cut of `dsh-devloop`. Plan slices through 0.2.3 are already on `main`. Tag `v0.2.3` and the GitHub Release are created **after** this packaging commit is merged; steps: [Deploy.md](./Deploy.md).

Package version: **0.2.3**. This document is the release note, not a second semver.

## What is in this version

Stacked merges already on `main` before the tag:

| Slice | PR | Ships |
|---|---|---|
| 0.1 docs | #2 | Design, Features, Plan, ADR |
| 0.1 core | #4 | `decideNextAction`, budget, router, `runTick` |
| 0.1 persist / plugin | #3 | `.devloop/STATE.json`, LOCK, Cordis Service, `dsh plugin add` |
| 0.2.1 AgentBackend | #5 | `run` / `cancel` / `health`; production default `NoopBackend` |
| 0.2.2 worktree | #6 | `.devloop/worktrees/<taskId>`, `CONTRACT.json`, LOCK heartbeat |
| 0.2.3 headless | #7 | `agentBackend: dsh` → `dsh --profile headless`; default stays `noop` |

Host-side checks (`dsh plugin add`, `--dump-config`) are listed in [UserCaseTest.md](./UserCaseTest.md) and are not claimed as already run on the release machine.

## Honest limits

- `merge` writes STATE only. No mechanical git merge, no worktree cleanup (Plan 0.2.4).
- No Codex / Claude CLI adapter (Plan 0.2.5).
- Worker output does not write task status back into STATE. PASS / REWORK is operator-driven.
- No unattended milestone loop (0.3) and no UI (0.4).
- npm registry: not published in this cut (no npm login on the release machine). Install from GitHub or the Release tarball. See [Install.md](./Install.md).
