# Release 0.5.5

Bounded autonomous engineering loop: structured model results, deterministic state transitions, host-enforced write scope, SHA-bound independent review, durable recovery, and role/tier routing. Tag `v0.5.5` and the GitHub Release are created **after** this commit is on `main`; steps: [Deploy.md](./Deploy.md).

Package version: **0.5.5**. This document is the release note, not a second semver.

## New in 0.5.5

The loop can be watched and understood from the page, and the trunk rule now
holds for the whole run, not only at start.

- **Every merge refuses the trunk.** 0.5.4 checked the branch when a loop
  started. Now the merge asks the same question each time, so a checkout
  switched back to `main`/`master`/the configured base mid-loop, or a project
  armed by writing GOAL.md by hand, halts with a new `merge_onto_trunk` hold
  (and a detached HEAD with `merge_detached_head`, which used to retry silently).
  The reviewed task stays `merge_ready`; the page says to move the checkout back
  and resume, and it merges on the next tick without being redone or paid for
  again.
- **A root that is not its own git toplevel is refused.** A plain directory
  inside another repository used to pass the start check with the outer
  repository's branch.
- **The planning documents are on the page.** The project page has a 文档 panel,
  before and after a start. It previews pilot's roadmap, tasks, progress,
  acceptance, architecture, spec and research from `docs_dir`, and DevLoop's own
  GOAL, PLAN, REVIEW and PROGRESS, rendered as markdown built from text nodes.
  Each task in the table now lists its acceptance criteria.
- **A guide on the home page.** It covers the path from a repository to a merged
  PR, step by step. It is open by default, and folding it away is remembered.
- **The header shows the installed version**, stamped from the package when the
  page loads, so it follows each release.

New hold reasons `merge_onto_trunk` and `merge_detached_head`; no config change.

Branch names are compared **case-folded**: on a case-insensitive filesystem
(macOS by default) `git switch Main` succeeds on a loose `main` ref, and an
exact comparison let merges advance main through it. PR-daemon's review
reproduced this on the Mac mini; it is fixed and tested here.

Still not guarded: a trunk named something other than `main`/`master` (say
`develop`) in a repository with no `.pilot.yml` and no `origin/HEAD` is not
known to be a trunk. Write `base_branch: develop` in `.pilot.yml`.

## New in 0.5.4

Starting a loop on an existing repository, rather than a fresh one.

- **Starting is refused where it would waste the run.** Before GOAL.md is
  written, the page and the server check three things. The checkout must be on a
  branch, and that branch must not be the trunk: DevLoop merges each task into
  the checked-out branch, locally, so a repository left on `main` would take
  commits straight into it. And no tracked file may have uncommitted changes,
  which every merge refuses — until now that was found only after plan, delegate
  and review had been paid for. The trunk comes from `.pilot.yml`'s
  `base_branch`, else `origin/HEAD`; `main` and `master` always count. A missing
  `.pilot.yml` or missing planning documents are shown as advice, not refusals.
  The page offers 重新检查 after you fix things by hand, and keeps the goal
  you had typed.
- **The planner reads what the repository already says.** Every backend's plan
  prompt (dsh, `claude -p`, `codex exec`, Harness subagents all share it) now
  names `AGENTS.md`, `CLAUDE.md`, `.pilot.yml` and the planning directory
  (`docs_dir`, default `docs/agent/`: roadmap, tasks, progress, architecture,
  spec). It reuses task ids and acceptance commands already written there, skips
  work marked done or out of scope, and lets GOAL.md win a disagreement.

Neither loads the pilot skill, and DevLoop still does not depend on it: pilot
runs in a Claude Code session, where a person can answer it, and DevLoop reads
the files it leaves behind. The intended order on an existing repository is:
`pilot status` / `pilot doctor` (clean up) → `pilot plan` (write `docs/agent/`)
→ `git switch -c devloop/<goal>` → add the project and start it → a single PR
from that branch.

A patch: no config and no state field change. An already-started project is
unaffected; the check applies only to starting one from the page.

**Behaviour change:** the page no longer starts a loop on `main`, `master` or
the configured trunk, and there is no switch to allow it. A repository whose
work really belongs on the trunk switches to a branch and brings it in by PR.
The check runs at start only: the merge does not re-check the branch yet, so
switching back to the trunk mid-loop, or arming by writing GOAL.md by hand, is
not guarded. A merge-time guard is the next change.

## New in 0.5.3

Fixes from PR-daemon's post-merge review of 0.5.2
([#34](https://github.com/jhfnetboy/DevLoop/pull/34), review 5175723651).
0.5.2 was tagged and released on GitHub but never published to npm; use 0.5.3.

- **An open picker no longer freezes a project page.** Opening 浏览仓库… and
  then clicking a project card left the picker marked open, and the refresh
  treats an open picker as editing, so the project page — gates, budget, loop
  state — stopped updating until the page was reloaded. Navigating now closes
  the picker, and it only holds the refresh on the home page.
- **A late listing cannot land under the wrong breadcrumbs.** Two quick clicks
  could answer out of order; only the most recent request's answer is shown.
- The browse route's guards — 401/403, 405, 501 without a browse root or
  project control, 422 for a missing directory or root — are now tested.
- Dashboard.md says plainly that the browse root limits the picker, not
  registration.

## New in 0.5.2

- **Add a project by picking it, not by typing its path.** 「添加项目」 now opens
  a browser over `~/Dev` (or `$DEVLOOP_BROWSE_ROOT`): open an organisation,
  click a repository to select it, then 添加. Repositories are marked, ones
  already added are shown and cannot be picked twice, and the page's refresh
  holds off while the picker is open so it is not closed under you.
- The picker is served by a new read-only route, `GET /devloop/api/browse`.
  It lists directory names only, one level at a time, and never outside its
  root: dot-segments are refused and a symlink that resolves outside is left
  out. Registering still goes through the same check as before — the choice
  must be a git toplevel.

A patch: no config, no state field. The free-text path box is gone; a
repository outside the browse root is added by setting `DEVLOOP_BROWSE_ROOT`
or by editing `$DSH_HOME/devloop/projects.json`.

## New in 0.5.1

Two fixes found by the first real run: a throwaway repository, everything on
DeepSeek through the dashboard. Plan, a Flash implementation, a Pro review
(PASS), the merge and `goal_complete` all ran in under a minute.

- **A finished goal no longer asks a question.** The loop stopped on
  `goal_complete` and the gate fell through to its generic "redo the task, or
  leave it?" with a single `stop` answer. The dashboard therefore showed a
  project that had simply succeeded as *halted, waiting for you*. `gateFor` now
  returns null for a completed goal, and the page says 已完成.
- **An unarmed root is left alone.** The budget snapshot was written at start,
  so the directory DSH was launched in grew a `.devloop/` whether or not it was
  a project. Under launchd that directory is `$HOME`. The snapshot is now written
  on the first armed tick.

Both have regression tests that were checked to fail without the fix. One of
them passed without the fix the first time it was written, because it read the
file before the fire-and-forget write had landed.

## New in 0.5.0

The operator surface. A minor: new pages, a new CLI verb, a new state field and
new config, though an upgrade from 0.4.2 changes nothing a running loop does
until a project is registered or a button is pressed.

| Change | PR | Ships |
|---|---|---|
| Dashboard | [#31](https://github.com/jhfnetboy/DevLoop/pull/31) | `/devloop/` in the web profile, behind DSH's own login: every project, its tasks, pending question, budget and events. Reachable over a tailnet via `tailscale serve --tcp` and `--trusted-host` |
| Operator verbs | #31 | answer / resume / pause from the page through the same code as the CLI; every write names the revision it answers and a moved state is refused (409); `devloop pause` |
| Waiting halts | #31 | a halted loop keeps its timer and writes nothing until the revision moves, so a resume needs no profile restart |
| Projects | #31 | one loop per registered project; register a git toplevel, start it by writing GOAL.md (never overwritten), remove it once paused; a shared daily cap and shared dispatch slots |

New state field `paused` (optional; a malformed one degrades to none). New
config `maxCostUsdPerDayAllProjects` (0 = one project's daily cap). New files
under `$DSH_HOME/devloop/projects.json`. The package ships a `dashboard/`
directory. Design and the security reasoning: [Dashboard.md](./Dashboard.md).

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
[`V0.6-TODO.md`](./V0.6-TODO.md); it was renamed rather than reset, because the
reasons attached to each deferred item are the point of it.

Known, and written down rather than hidden: the gate prints `devloop answer
retry`, which is the one line an operator cannot paste, because nothing links a
package's own `bin` onto `PATH`. Tracked in
[`V0.6-TODO.md`](./V0.6-TODO.md) with the three candidate fixes.

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
- The operator UI is the dashboard; it sees only the spend backends report, and cannot edit an existing goal.
- npm registry: `@jhfnetboy/dsh-devloop@0.5.5` is published. GitHub and the Release tarball remain supported. See [Install.md](./Install.md).
