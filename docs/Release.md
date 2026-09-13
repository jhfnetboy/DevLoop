# Release 0.6.7

Bounded autonomous engineering loop: structured model results, deterministic state transitions, host-enforced write scope, SHA-bound independent review, durable recovery, and role/tier routing. Tag `v0.6.7` and the GitHub Release are created **after** this commit is on `main`; steps: [Deploy.md](./Deploy.md).

Package version: **0.6.7**. This document is the release note, not a second semver.

## New in 0.6.7

DeepSeek work defaults to **DeepSeek V4.1 Flash**, by the API id DeepSeek
published for it (notice of 2026-09-10) and DeepSeek Harness 0.1.5's own
default agent model: `deepseek-flash`.

- **Default routes** ([#144](https://github.com/jhfnetboy/DevLoop/pull/144)).
  `routing.T1` and `routing.T2` default to `deepseek-flash` instead of
  `deepseek-v4-flash` (deprecated, routed to V4.1 Flash for now) and
  `deepseek-v4-pro` (served by V4.1 Flash from 2026-09-14 12:00 Beijing
  time). A profile that names its routes is unchanged.
- **Prices** ([#143](https://github.com/jhfnetboy/DevLoop/pull/143)).
  `deepseek-flash` is priced from the V4.1 Flash card; `deepseek-v4-flash`
  and `deepseek-v4-pro` at the same card, each with a note saying why; all
  are billed as `deepseek-flash`. docs/Pricing.md lists the ids.

The model id passes through to DeepSeek's API, so dsh builds before 0.1.5
use `deepseek-flash` too (as a text-only route); dsh 0.1.5 adds its image
input and in-history system prompt updates.

## New in 0.6.6

One repository, worked on goal after goal, every change reviewed. Found by
running 0.6.5 end to end on a live dashboard and a sandbox forge repository,
and shaped after LoopX, where a goal is long-lived and
finished work stays with it.

- **The next goal on the same repository** ([#128](https://github.com/jhfnetboy/DevLoop/pull/128)–[#131](https://github.com/jhfnetboy/DevLoop/pull/131)).
  A finished project's page shows a "Next goal" box. The finished goal is
  archived under `.devloop/archive/NNNN/` (GOAL, STATE, PLAN, REVIEW,
  PROGRESS) under the state lock, and the next is planned on the same work
  branch; spend carries over, per-task counters restart. Where the forge
  merges, the next goal waits for the finished one's release to merge, its
  task ids get a `g<N>-` prefix so its branches never meet an earlier goal's,
  and its release is matched by number, never by an earlier goal's merge.
- **Each project pushes to its own forge repository** ([#132](https://github.com/jhfnetboy/DevLoop/pull/132), [#135](https://github.com/jhfnetboy/DevLoop/pull/135), [#136](https://github.com/jhfnetboy/DevLoop/pull/136)).
  Before a registered project first starts on the forge route, the page shows
  its checkout's origin (read without `insteadOf`) for the operator to
  confirm; it is kept in the project registry, never re-read from the
  checkout, and the project's loop runs with it. Also fixes the forge route
  failing to start when a profile never named `forge.localReview`.
- **Mechanical checks fix before review** ([#133](https://github.com/jhfnetboy/DevLoop/pull/133)).
  A commit the pre-PR checker blocks on a rule, or whose acceptance command
  fails, goes back to the worker with what the check said, bounded by the
  task's attempts; only size alone (split the task) or no verdict still asks
  the operator. The PR record shows how many tasks passed their first review
  ([#139](https://github.com/jhfnetboy/DevLoop/pull/139)).
- **Safer with a repository that is already in use** ([#127](https://github.com/jhfnetboy/DevLoop/pull/127), [#137](https://github.com/jhfnetboy/DevLoop/pull/137), [#140](https://github.com/jhfnetboy/DevLoop/pull/140)).
  A branch named for a task that holds other work is never reset: the task
  holds and asks (`task_branch_taken`). A forge merge removes the task's
  worktree. `.devloop/` is added to the local `info/exclude`. Ahead/behind
  is counted against the remote's trunk.
- **Say what the task is** ([#134](https://github.com/jhfnetboy/DevLoop/pull/134), [#138](https://github.com/jhfnetboy/DevLoop/pull/138)).
  Task commits are `<task id>: <title>`; the task pull request lists the
  contract's acceptance and allowed paths; the release links each task's
  pull request.

New: `.devloop/archive/`, STATE `goal` and `Task.pullRequest`, registry
`pushUrl`, hold reason `task_branch_taken`, `POST /api/projects/<id>/next`.
Checked before release by a forge E2E in the sandbox: two goals in a row on
one work branch, four pull requests reviewed and merged by DevLoop.

## New in 0.6.5

Hardening and polish of 0.6.4's per-task pull requests, from PR-daemon's
reviews of it. No new mode; local mode gains the git and credential fixes too.

- **Models run without the host's credentials** ([#111](https://github.com/jhfnetboy/DevLoop/pull/111)).
  Every worker, reviewer and planner (dsh, claude, codex) starts without any
  inherited `GIT_*`, `GH_*`, `GITHUB_*` or `SSH_*` variable — git's numbered
  `GIT_CONFIG_KEY_n`/`VALUE_n` included — with `gh` pointed at an empty config
  and git at no global or system config. dsh is pinned to `workspace-write`.
  A model's own sandbox is still what stops it reading credential files on disk.
- **Every host git through one hardened helper** ([#113](https://github.com/jhfnetboy/DevLoop/pull/113), [#114](https://github.com/jhfnetboy/DevLoop/pull/114)).
  Inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR` no
  longer redirect it, fsmonitor and hooks are off; project registration and
  the pre-PR checker included.
- **Checks you can require** ([#112](https://github.com/jhfnetboy/DevLoop/pull/112), [#123](https://github.com/jhfnetboy/DevLoop/pull/123)).
  `forge.requireChecks: true` makes a commit with no checks wait instead of
  counting as green. Checks are read in the same call as the pull request's
  head, so a later push cannot lend the reviewed commit its checks.
- **A forge refusal is its own question** ([#119](https://github.com/jhfnetboy/DevLoop/pull/119), [#124](https://github.com/jhfnetboy/DevLoop/pull/124), [#125](https://github.com/jhfnetboy/DevLoop/pull/125)).
  Branch protection, an expired `gh` login or empty forge settings hold as
  `forge_merge_refused`: fix it outside DevLoop and resume; the worker is not
  run again. The checkout failing to follow the merge stays `merge_wedged`;
  a pull request pushed to or retargeted since review holds as
  `no_review_pass`, to be reviewed again.
- **Gates and bodies that say what happens** ([#114](https://github.com/jhfnetboy/DevLoop/pull/114), [#117](https://github.com/jhfnetboy/DevLoop/pull/117), [#120](https://github.com/jhfnetboy/DevLoop/pull/120), [#121](https://github.com/jhfnetboy/DevLoop/pull/121), [#122](https://github.com/jhfnetboy/DevLoop/pull/122)).
  The release body says how it is decided (a GitHub review, always) and marks
  tasks accepted without a change; a trunk or detached checkout held before
  review no longer says the task "passed review"; a superseded trunk pull
  request is closed; a task merged by someone else is logged as a warning.
- **Review notes** ([#115](https://github.com/jhfnetboy/DevLoop/pull/115), [#116](https://github.com/jhfnetboy/DevLoop/pull/116), [#118](https://github.com/jhfnetboy/DevLoop/pull/118)).
  A local reviewer's long notes are cut at 8192 characters instead of stopping
  the loop; the PR log names the local reviewer.

New config: `forge.requireChecks` (default `false`). New hold reason:
`forge_merge_refused` (the only new value STATE can hold). New PR-LOG field:
`localReviewer`.
Not in 0.6.5: automatic retry of transient forge merge errors (gh gives no
signal to tell them from refusals).

## New in 0.6.4

One GitHub pull request per task, reviewed there and merged by DevLoop, then
one release pull request to trunk: the per-task review the 0.6 design set
out, run end to end in a sandbox repository before release. Off unless
`reviewerRoute` names the `forge` backend; without it tasks merge locally as
before. How to turn it on: README, "One pull request per task".

- **Verdicts from GitHub reviews** ([#93](https://github.com/jhfnetboy/DevLoop/pull/93), [#98](https://github.com/jhfnetboy/DevLoop/pull/98)).
  Only allowlisted reviewers who are not this host, only reviews of exactly the
  reviewed commit, each reviewer's latest word; any request for changes
  outranks every approval and is rework. An approval passes only once the
  commit's checks are green. `forge.verdictSource: comments` keeps the old
  envelope path; exactly one source is read.
- **Rework carries the review** ([#95](https://github.com/jhfnetboy/DevLoop/pull/95), [#96](https://github.com/jhfnetboy/DevLoop/pull/96), [#105](https://github.com/jhfnetboy/DevLoop/pull/105), [#106](https://github.com/jhfnetboy/DevLoop/pull/106)).
  A request for changes' body — PR-daemon's, or the local reviewer's — reaches
  the worker's next attempt, as one quoted string, and survives a failed or
  blocked attempt; it is dropped once an attempt is handed in or the task is
  accepted.
- **The work branch** ([#94](https://github.com/jhfnetboy/DevLoop/pull/94), [#97](https://github.com/jhfnetboy/DevLoop/pull/97), [#107](https://github.com/jhfnetboy/DevLoop/pull/107)).
  Recorded at the first delegate; task pull requests target it, labelled
  `devloop`, never trunk. It is created on the forge at the task's base,
  fast-forwarded when behind, left alone when ahead, refused when moved away;
  a review with no work branch holds on trunk or detached instead of opening a
  pull request.
- **A local review first** ([#99](https://github.com/jhfnetboy/DevLoop/pull/99)).
  `forge.localReview` runs a local reviewer before the pull request opens, and
  its usage counts toward the caps.
- **DevLoop merges** ([#100](https://github.com/jhfnetboy/DevLoop/pull/100)–[#102](https://github.com/jhfnetboy/DevLoop/pull/102)).
  The verdict and checks are read again, then `gh pr merge --match-head-commit`
  from an empty directory; the checkout fetches the merge commit by id and
  fast-forwards to it before the task is done. Already merged is not merged
  twice; anything that cannot be completed holds.
- **The release pull request** ([#103](https://github.com/jhfnetboy/DevLoop/pull/103), [#104](https://github.com/jhfnetboy/DevLoop/pull/104)).
  Opened once every task is done, looked at each tick outside the state lock,
  merged once approved with green checks, on the forge only.
- **Security fix: a worker could run a program as the host through git**
  ([#108](https://github.com/jhfnetboy/DevLoop/pull/108)). Found by PR-daemon's
  review. The Codex delegate was granted its worktree's gitdir, and any worker
  could rewrite its worktree's `.git` pointer; either could point the host's
  next git call — committing the task, the pre-PR checker, the repository
  status scan — at a repository whose config runs a program. Codex no longer
  gets the gitdir, and every host git call in a task worktree pins its git
  directories to the host's own paths with fsmonitor and hooks off. This
  predates 0.6.4 and affects local mode too.

Carried to 0.6.5 (from the reviews), and closed there: workers inherited this
host's `gh` login; an empty set of checks counted as green; a few messages and
gate texts to tighten. 0.6.x numbers follow the release plan rather than strict semver.

## New in 0.6.3

The page speaks English, Chinese and Thai. A switch at the top right
(EN · 中 · ไทย) changes every word the page draws, in place, and is
remembered on that browser; **English is the default**.

- **The page's own words** ([#77](https://github.com/jhfnetboy/DevLoop/pull/77)–[#82](https://github.com/jhfnetboy/DevLoop/pull/82)).
  `dashboard/i18n.js` holds each string as `[English, 中文, ไทย]`, served at
  `/devloop/i18n.js` behind the page's authentication. Headers, the home
  lanes, cards, the start panel, the gate and halt panels, tasks, budget,
  events, documents, the guide, repository status and the PR record all go
  through it; times use the reader's locale (Thai dates show the Buddhist
  year). A missing translation falls back to English and an unknown key
  shows as itself.
- **What the server says, by code** ([#83](https://github.com/jhfnetboy/DevLoop/pull/83)–[#90](https://github.com/jhfnetboy/DevLoop/pull/90)).
  Readiness checks, cleanup reasons, protect_patterns warnings, every gate's
  question, evidence and steps, and the halt reasons now carry a stable code
  and the values their sentence uses; the page says them in the reader's
  language and falls back to the server's own words for a code it does not
  know. The CLI and the server's messages are unchanged.
- **Tests keep it whole.** Every key the page asks for, every code the server
  can send and every gate family in `gate.ts` must have all three languages;
  a key defined twice fails the suite.
- Fix: a saved language is taken only when it is one of the three by own
  property (a stored `constructor` used to break every date on the page).

Not translated, on purpose: what models and people wrote (task titles,
GOAL.md, planning documents) and raw identifiers (reason codes, commands,
branch names).

New fields: readiness `code`/`params`, cleanup `code`, `ProtectDrop.code`,
gate `key`/`vars`, halt `details` (`haltDetails` on a project). No config or
STATE change. 0.6.x numbers follow the release plan rather than strict
semver.

## New in 0.6.2

The page answers "what needs me?" first, and says what an answer costs before
it is given. Both ideas are borrowed from LoopX's control plane.

- **The home page is grouped by attention** ([#71](https://github.com/jhfnetboy/DevLoop/pull/71), [#72](https://github.com/jhfnetboy/DevLoop/pull/72), [#74](https://github.com/jhfnetboy/DevLoop/pull/74)).
  Four columns, in this order: 等你处理 (a halt asking a question, a project
  the page cannot read, an armed loop whose process has stopped), 进行中, 闲置
  (not started, paused, or a halt answered "leave it" while it is still that
  halt), 已完成. Once there are projects they come before the guide and the
  picker. Each card says in one sentence what happens next or what it waits
  for, and how long it has waited. Each project's summary carries its `lane`
  and `since`.
- **A halt offers one answer, with its cost** ([#73](https://github.com/jhfnetboy/DevLoop/pull/73), [#75](https://github.com/jhfnetboy/DevLoop/pull/75)).
  Every answer now says whether a model is paid again and whether existing work
  is thrown away. The gate names a recommended answer, which is the page's one
  primary button; the others are folded under 其他选项. A gate whose only
  answer is to leave it leads with 要你做的事, the steps for the person.
- **Fix: `retry` said "from a clean worktree"; it is not.** A retry runs the
  worker again in the task's existing worktree and base. The summary, the docs
  and the new impact say so. A redo from a clean base is still the manual
  command in the over-budget and replan gates.

A patch: new summary fields (`lane`, `since`) and gate fields (`recommended`,
`impact`), no config change and no STATE change.

## New in 0.6.1

The per-PR budget, enforced by PR-daemon's own rules and recorded so it can
be judged on data. Each task's change goes through PR-daemon's mechanical
pre-PR checker before any reviewer is paid; the rules live in the PR-daemon
repository and are only called from here, so a rule change there reaches the
loop with a `git pull`, without a DevLoop release.

- **The checker gates the review** ([#55](https://github.com/jhfnetboy/DevLoop/pull/55)–[#57](https://github.com/jhfnetboy/DevLoop/pull/57), [#65](https://github.com/jhfnetboy/DevLoop/pull/65)).
  Off by default; set `prePrCheck` to the checker's argv
  (`['bash', '~/Dev/tools/PR-daemon/scripts/pre-pr-check.sh']`), with
  `prePrProfile` (`devloop`) and `prePrTimeoutMinutes` (5). DevLoop knows only
  the checker's contract — argv, exit codes, JSON — and never a rule. Exit 0
  passes; exit 1 with a blocking finding holds the task, as
  `task_over_budget` when only size rules blocked (redo it smaller) or
  `prepr_blocked` otherwise (SZ-4, high-risk content mixed in, is not a size); anything else, a timeout, or a result that
  disagrees with itself holds as `prepr_unavailable`, never a pass.
- **The budget has an elastic band** ([#64](https://github.com/jhfnetboy/DevLoop/pull/64)–[#69](https://github.com/jhfnetboy/DevLoop/pull/69)). Up to 200 lines, 5 files and
  2 counted top-level directories is normal; up to 260 / 6 / 3 is elastic —
  reviewed, with the size put in front of the reviewer, who is asked to judge
  whether it should have been split (REWORK or REPLAN); beyond that the task
  is refused as over budget. The thresholds are PR-daemon's (`size.band`,
  `size.limits`, rules 1.2.0); an older checker's result is read as normal or
  over from its blocks.
- **The planner is told the budget and estimates each task's size**
  ([#59](https://github.com/jhfnetboy/DevLoop/pull/59), [#66](https://github.com/jhfnetboy/DevLoop/pull/66), [#67](https://github.com/jhfnetboy/DevLoop/pull/67)). The estimate is
  never enforced — a malformed one is dropped, not the plan — and is logged
  beside the checker's count, the data the estimate rules will be tuned on.
- **`.devloop/PR-LOG.jsonl` and the PR 记录 panel**
  ([#58](https://github.com/jhfnetboy/DevLoop/pull/58), [#61](https://github.com/jhfnetboy/DevLoop/pull/61)–[#63](https://github.com/jhfnetboy/DevLoop/pull/63), [#65](https://github.com/jhfnetboy/DevLoop/pull/65)).
  One line per check — size, band, estimate, rules hit, rules version — and
  per review verdict. Best-effort (a lost line costs only that line), never
  through a symlink, and a malformed line is dropped rather than taking the
  page down. The project page shows the latest 50, marking 弹性 and 超限.
- **Redoing a task smaller is real** ([#60](https://github.com/jhfnetboy/DevLoop/pull/60)).
  The over-budget and replan gates used to suggest editing PLAN.md, which the
  loop never reads back; they now give the commands that redo the task from
  its base, and the worker's prompt states the budget.
- **A pending hold that cannot be read says so on every tick**
  ([#59](https://github.com/jhfnetboy/DevLoop/pull/59)). One kept through a
  read error (EACCES and the like) used to wait in silence until it read.

A minor: three new optional config keys, new optional task fields
(`overBudget`, `estimate`), a new file under `.devloop/`, no change to
existing behaviour while `prePrCheck` is unset.

## New in 0.6.0

The first step of the 0.6 plan (design: draft PR [#42](https://github.com/jhfnetboy/DevLoop/pull/42)): DevLoop does
the status half of pilot's work itself — see a repository's branches and
worktrees, and clean up merged branches — from the page, without a skill.
Shipped as eleven reviewed PRs, each inside the per-PR budget and each through
PR-daemon's mechanical pre-PR rules, a local review and PR-daemon's review.

- **仓库状态 panel** ([#43](https://github.com/jhfnetboy/DevLoop/pull/43)–[#47](https://github.com/jhfnetboy/DevLoop/pull/47), [#49](https://github.com/jhfnetboy/DevLoop/pull/49), [#50](https://github.com/jhfnetboy/DevLoop/pull/50)).
  On every project page, before and after a start: current branch, trunk,
  ahead/behind, uncommitted changes; the merged branches that can go, as ticked
  checkboxes; every kept branch with its reason; the steps left to a person
  with their commands. 删除选中的分支 runs `git branch -d` for the ticked
  branches the plan still offers at that moment, and says which were deleted
  and why any were not. The rules it keeps are in
  [Dashboard.md](./Dashboard.md) ("Branch cleanup deletes only what git itself calls safe").
- **`.pilot.yml` protect_patterns are honoured**, read as a superset of pilot's
  own ref hook (both list forms, CRLF, blank and comment lines, non-ASCII
  names) and never below release/hotfix/deploy; entries that protect nothing,
  such as globs, are shown as a warning.
- **A finished dispatch waits for the state lock to save its result**
  ([#51](https://github.com/jhfnetboy/DevLoop/pull/51)) instead of dropping it
  after one try, and a hold that cannot get the lock is kept in
  `.devloop/PENDING_HOLD` for the next tick.
- **Fix: a tag named like the trunk no longer hides it**
  ([#48](https://github.com/jhfnetboy/DevLoop/pull/48)). With a tag `main`, git
  shortened the branch to `heads/main` and the start check let a loop start on
  main; branches are now read by full ref.

A minor: new operator surface and a new endpoint pair
(`GET …/projects/<id>/status`, `POST …/projects/<id>/cleanup`), no config
change and no new STATE field.

## New in 0.5.6

The last loose ends before 0.6, and the first release made the new way: split
into PRs inside the per-PR budget (≤200 lines, ≤5 files, ≤2 counted top-level
directories), each passing PR-daemon's mechanical pre-PR rules and a local
review before PR-daemon reviewed it.

- **Each task records who planned it** ([#38](https://github.com/jhfnetboy/DevLoop/pull/38)).
  STATE named the implementer and reviewer but not the planner, so after the
  switch to three-way routing only Codex's own logs showed who planned. Every
  task a plan creates now carries `planner` (the route identity), validated on
  load like the other two; STATE files without it load unchanged.
- **The page shows all three roles, and a selection no longer freezes it**
  ([#40](https://github.com/jhfnetboy/DevLoop/pull/40)). Each task row reads
  `规划 … · 实现 … · 评审 …`. The refresh used to pause for any text selection
  until the reader clicked elsewhere, so a task id selected to copy froze the
  gate and budget; it now pauses only for a selection inside a document, and
  for at most 60 seconds.

A patch: a new optional task field, no config change.

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
- npm registry: `@jhfnetboy/dsh-devloop@0.6.4` is published. GitHub and the Release tarball remain supported. See [Install.md](./Install.md).
