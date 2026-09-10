# Research: `nzl153/dsh-devtools`

What that monorepo does, what is worth taking, and what is worth refusing. Read
against this repo's `src/` at 0.4.1, not against its README.

Clones live in `wind/` (gitignored, `--depth 1`, read-only reference). Nothing
here is copied code; see [Provenance](#8-provenance) before that changes.

This is the second draft. A fact-check and an adversarial design review of the
first draft are recorded in [§9](#9-what-the-review-changed); three of the
conclusions below reverse the first draft's.

Packages read in full: `dsh-dev-loop` 0.10.0 (holds the npm name),
`dsh-run-lab` 0.9.0 (A/B experiments), `dsh-toolkit-ui` 0.2.0 (shared shell).
Packages read for specific findings: `dsh-debrief`, `dsh-session-archaeologist`,
`dsh-time-machine`, `dsh-context-xray`, `dsh-output-gallery`.

## 0. The name is a collision; the suite is a strategic question

`dsh-dev-loop` is a **Build / Test / Run / Restart panel**. It reads
`.dsh/devloop.yml`, spawns the commands an operator declared, streams output into
a web panel, saves logs, and forwards the last failure to whatever agent is live.
No planner, no delegation, no review, no budget. It does have a state machine
(`core/state-machine.ts`), but over a single command run — `idle → running →
succeeded | failed | cancelled` — not over tasks. "Dev loop" there means the
edit-build-test loop a human runs; here it means a bounded plan → delegate →
review → merge loop a program runs. Their cordis id is `dsh-dev-loop` and their
state lives in `~/.dsh/dev-loop/`; ours are `devloop` and `.devloop/`.

They have also already published the answer to the npm half: `dsh-time-machine`
was taken, so the package ships as `dsh-devtools-time-machine` while the plugin
id, directory, patch file, API routes and locale namespace all stay
`dsh-time-machine`. `@jhfnetboy/dsh-devloop` is the same move, and it is settled.

**But the package is the wrong unit of analysis.** The competitor is the suite:
nine plugins on a shared shell, organized as before / during / after an agent
run, published, screenshotted, each with a stated risk level. Three real risks
the name framing hides:

1. **`dsh-run-lab` already is the arena in `V0.6-TODO.md`** — shipped, with
   isolation, metrics, repeat-N, a CLI and an E2E. Our arena is behind before it
   starts. The question is not how to build it but whether to.
2. **`dsh-debrief` + `dsh-output-gallery` + `dsh-context-xray` occupy the
   observability layer a 0.5 operator surface would occupy.** The fork is
   build-vs-emit: ship a panel, or emit `session/event`-shaped data and let that
   suite render it. §3 answers a small version of this question; §7 asks the
   large one.
3. **The alias.** Our README tells operators to alias `devloop`. A user of the
   other tool wants the same word for the same-sounding thing. One README line
   does not resolve a shell alias collision on a machine carrying both.

The repo is MIT, explicitly unsupported (*"issue 和 PR 可能不会回复"*), verified on
Windows / Git Bash only against DSH `0.1.0-rc.6`. A source of shapes, not a
dependency.

## 1. The finding that matters most is ours, not theirs

`spawn.ts` rejects a non-zero exit with `new Error(\`exit ${closeCode}\`)` and
drops the accumulated `stdout`/`stderr`. `runAcceptanceChecks` catches that and
stores `error.message`, so `AcceptanceFailure.detail` is the string `exit 1` and
the `MAX_DETAIL = 4_000` truncation beside it is unreachable.

It is worse one frame up. In `service.ts`:

```ts
this.ctx.logger.error(`[dsh-devloop] acceptance failed: ${failure.argv.join(' ')} — ${failure.detail}`)
throw new Error(`acceptance_failed: ${failure.argv.join(' ')}`)
```

`detail` reaches the **logger only**. It never enters `STATE.json`,
`EVENTS.jsonl`, `PROGRESS.md`, or the gate. So carrying output onto the
rejection, on its own, changes nothing an operator sees.

And the obvious next move is a trap. `acceptance_failed:${argv}` is not a
message, it is a **key**: `implementationFailureReason` → `HoldReason` →
`supervisor.reason`; `gateFor` splits it on `:` to dispatch through
`KNOWN_GATES`; `actionKey` folds it into `escalate:id:${taskId}:${reason}`, which
`recordAction` pushes onto `usage.lastActions`, which is what `maxSameAction` and
the no-progress latch count. Test output is nondeterministic — timings, temp
paths, seeds. Put it in the reason and every failure gets a fresh key, so
`duplicate_action` stops firing and the latch stops latching for exactly the case
they exist to catch: a task failing the same check over and over. An unreadable
hold reason traded for a dead circuit breaker.

**The design question is therefore where worker-produced evidence lives such that
it never enters a value the state machine keys on.** The answer is a separate
evidence channel — a field on the `EVENTS.jsonl` record, or
`.devloop/worktrees/<id>/LAST_FAILURE.txt` — with the hold reason staying the
short stable key it is today and the gate's `evidence[]` reading the artifact.
Everything the three packages offer about output handling (§2) is what goes
*into* that channel; none of it decides where the channel is.

## 2. `dsh-dev-loop` — what happens around running a command

Different product, and the most directly usable ideas of the three, because
everything it does is the part of our `acceptance.ts` that is one line long.

### Worth taking

1. **Bounded failure context, taken from the end.** `extractLastFailSection`
   finds the last line matching
   `error|fail|exception|fatal|panic|traceback|failed|✗|×`, returns it with 8
   lines before and 6 after, capped at 4k. (Its `maxLines = 40` parameter is
   unused — take the shape, not the signature.) This is the payload for §1's
   evidence channel.
2. **`truncateOutput` keeps head *and* tail** around an explicit
   `… [output truncated] …` marker. A head-only truncation of a test log is the
   least useful 4k of it. Not a separate item from (1) — it is how (1) is bounded.
3. **Two-layer secret redaction.** A key-name heuristic
   (`KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|API_?KEY`) over env, *and*
   `redactText(text, secrets)` replacing the literal values in captured output.
   A prerequisite for (1): the moment we start capturing, it lands in files an
   operator pastes into an issue.
4. **Strip ANSI before persisting.** Every real CLI backend (`claude`, `codex`,
   `dsh`) emits escape sequences; our artifacts are meant to be read as text.
5. **A degradation path stated in the return type.**
   `SendErrorResult = { ok, method: 'agent-followup' | 'fallback-copy', message }` —
   when no live agent exists, the caller is *told* to fall back and handed the
   text. The generalization: an action that cannot complete returns the manual
   alternative rather than a failure. That is our open PATH TODO's shape.
6. **Re-entrancy guard plus queued-latest.** `WatchScheduler` is two booleans, no
   dependencies, unit-tested without touching the filesystem: a trigger arriving
   while running sets `pending` instead of spawning; `finish()` returns whether to
   run once more immediately. This is not a watch-mode nicety. It is the
   mechanism for the half of gates we did not build — see §5 A5.
7. **Named actions.** `.dsh/devloop.yml` gives each action a name, `cwd`, `env`
   and `timeout`. Compare our `acceptance: string[][]`: a gate can report an argv
   dump, never "acceptance step `test` failed".

### Worth refusing

- **Their config parser collects non-structural problems into `warnings[]`
  instead of throwing.** Correct for them — an experiment that measures less is
  still an experiment. Wrong for us: `assertAcceptanceChecks` throws at load, and
  it must, because a silently dropped acceptance check is invisible. The loop
  keeps running, the operator believes evidence is being gathered, and it is not.
  Take the names; refuse the warnings model.
- **`dependsOn`.** A DAG bought to get "step `test` failed after `build` passed",
  which `{name, argv}` over an ordered list with first-failure-wins gets free.
  Machinery for three commands.
- **A trust store as a second source of truth.** Their commands come from
  `.dsh/devloop.yml`, a file a repo can ship — untrusted input, so a confirmation
  ceremony is right. Ours come from the operator's own profile config, which is
  already a timestamped per-project record of exactly which commands they
  consented to. A `TRUST.json` beside it adds a way for config to say checks are
  on while the store says otherwise, and the loop then advances on the worker's
  claim while the operator believes it is gathering evidence. Strictly worse than
  the failure it prevents. (The first draft had this in Tier A; it is now C1.)
- **`trustedRequest()`** (loopback + `sec-fetch-site` + origin/host match) is a
  clean same-origin guard for an HTTP surface we do not have.
- Their trust key is `root.toLowerCase()` — right on Windows, wrong on a
  case-sensitive filesystem. If we ever key anything on a path, key on realpath.

## 3. `dsh-run-lab` — the arena, already shipped

Same task, two isolated workspaces, objective metrics, sequential `A×N` then
`B×N`. 2.8k lines with no runtime dependency on DSH internals (`@deepseek-ai/*`
are all devDependencies), so the engine is testable outside a host — the same
discipline our `src/` keeps.

### Worth taking

1. **Repeat-N, success rate, medians.** `host/engine.ts` runs each branch N
   times; `core/repeat.ts` aggregates — `successRate`, `medianWallTimeMs`,
   `medianToolCalls`, `medianInputTokens/OutputTokens`. The idea is not about
   arenas: **our loop accepts or reworks on one sample.** `maxTaskAttempts: 3`
   already budgets for three; we throw the first two away rather than compare
   them. See §7 Q4 for what makes this expensive.
2. **`null` plus a note, never a fabricated number.** No token feed means the
   metric is `null` and a string lands in `notes[]`. Honest — but see §4, where
   another package in the same repo solves the problem instead of labelling it.
3. **Isolation records which method it used**, so teardown and diffing branch on
   it. Worth copying as a habit even though we should stay git-only (below).
4. **Diff metrics.** `git diff --stat HEAD` for `filesChanged` / `diffSize`. We
   have no size-of-change signal, and we already ship a hold — `empty_task` —
   that exists because we could detect the degenerate case and nothing else.
   `dsh-time-machine` does this better (§4).
5. **A CLI as a co-equal surface** (`create` / `run`, real `bin`), so an
   experiment can be scripted without the panel.
6. **An E2E that mocks nothing structural.** Temp git repo, deliberately wrong
   `sum()`, a fake agent printing `input tokens: 100, output tokens: 40`, two
   evaluators, then assertions on winner, diff and wall time. Real git, real
   worktrees, fake model. The exact shape our loop tests should have.
7. **`AgentDriver` with a reserved second implementation** — `dsh-inproc` named,
   unwired, with the reason in the header. Narrow borrow: the `$WORKSPACE` /
   `%WORKSPACE%` convention and the `notes[]` channel. The wide lesson is §4.

### Worth refusing

- **`compare()` picks a winner by counting.** Twelve metrics, one unweighted
  point each, `+3` for success, ties scoring nothing. Fewer `toolCalls` can
  outvote a larger correct diff, and any `null` column silently leaves the
  tally — except `errors`, which initializes to `0` and therefore always votes.
  Take the columns; do not take automatic selection.
  Note what refusing costs: `GateOption` is `retry | review | accept | stop`.
  There is no "take branch B", and adding one is a new option class where an
  operator selects *code*, which must still pass independent review to merge.
  That is a change to the gate contract, not a menu entry.
- **Their evaluator's `junitFile` and `regexAssertions` as a verdict source.**
  Today acceptance is one bit produced by a process the host started. A parsed
  JUnit file is **an artifact the worker wrote** — a worker that wants to pass
  writes a green XML. That is precisely the *executor and auditor are the same
  entity* failure our README claims to address more strictly than it asks. The
  configuration being operator-authored does not help; the file is still the
  worker's. If this ships at all: **JUnit counts are reported in `PROGRESS.md`
  and never consulted for pass/fail.** Drop `regexAssertions` outright — an
  operator regex over untrusted worker stdout is a ReDoS surface and a second,
  weaker verdict channel. Keep `expectExitCode` and `expectFileExists`.
- **Copy isolation as a fallback.** "Arena only, merge path stays worktree-only"
  is not containable: `assertTaskChangesAllowed`, `commitDirtyTaskWorktree`,
  `taskWorktreeHeadSha`, the `baseSha`/`implementationSha` binding and
  `empty_task` are git operations with no directory-copy analogue. A copy branch
  produces a result the merge path cannot consume and cannot scope-check. The
  arena requires a repo — the same refusal `worktree.ts` already makes.
- **`assertSafePath` rejects any path containing whitespace** — on macOS, a large
  share of real project paths. It is also exported and never called;
  `createIsolatedWorkspace` validates nothing. A guard nothing calls is worse
  than no guard.
- **`aggregateBranchRuns` returns `status: runs.every(...) ? 'completed' : 'completed'`** —
  a dead ternary, with `runBranch` recomputing immediately after. Small, but it
  says the aggregate is not authoritative about its own field.
- **Medians over `null`-heavy columns compare different sample sizes** silently:
  `median()` filters nulls, so a median of 2 reporting runs out of 5 is presented
  identically to a median of 5.

## 4. The packages the first draft skipped — where the largest finding is

### `dsh-debrief` — a working token feed, in process

`src/host/index.ts` subscribes to `ctx.on('session/event', …)`; `src/core/tokens.ts`
reads provider-reported `inputTokens` / `outputTokens` / `cacheReadTokens` /
`cacheWriteTokens` off `assistant/message` events and carries
`precision: 'exact' | 'unavailable'`, with an explicit refusal to estimate.

This is the mechanical answer to our largest instrument gap. `V0.6-TODO.md` says
usage reporting is deferred because *"`dsh --profile headless` has no output
options, so T1/T2 spend is invisible to the cost cap — the tier that spends the
most."* That diagnosis is incomplete. `src/harness.ts` already ships
`HarnessSubagentBackend`, running providers **in process** through
`ctx.subagents`, on the same cordis context — and it returns neither `tokens` nor
`costUsd` on any path, although `BackendResult` has both fields. The gap is not
that dsh has no output options; it is that the one-shot CLI shape hides usage the
in-process shape exposes.

`dsh-debrief` is also, structurally, the closest package in the repo to
`PROGRESS.md`: deterministic, non-LLM, computed from an event stream, with a
stated never-guess rule.

### `dsh-session-archaeologist` — a budget, not a constant

Bounded excerpting with an explicit `maxChars = 8000 / maxTokens = 2000` budget,
provenance on every fragment, and a hard rule against injecting a whole prior
session. Same problem as §1 and §2.1 — how much worker-produced text may cross
into a durable artifact or a later prompt — but reasoned about as a budget rather
than a per-site magic number. Our `MAX_DETAIL = 4_000` is a per-site constant,
and REWORK feedback carried into the next attempt has no bound at all.

### `dsh-time-machine` — the strong version of a diff signal

A session baseline with per-file hashes, incremental pre/post-tool scans, rename
detection, and a conflict rule that re-hashes before writing and never
auto-overwrites. §3.4's `git diff --stat` is the weak version. It is also the one
package they rate **High** risk with a stated reason — the model to copy for the
Security section, rather than the convention in the abstract.

### `dsh-context-xray`, `dsh-output-gallery`, and one absence

- Context X-Ray instruments context composition. Our README *asserts* pollution
  is handled — "a fresh worktree and a one-shot CLI per task keep history out" —
  with nothing that confirms it. Worth logging as an unverified claim.
- Output Gallery's stance on model-produced artifacts (sandboxed iframe, never
  `dangerouslySetInnerHTML`, never auto-extract, executables show metadata only)
  is the safety baseline any panel of ours needs on day one, not later. Filed
  against C2.
- **`dsh-preflight` is listed in their toolkit README as the environment-diagnosis
  package and is not in the monorepo.** That is exactly the job of a
  `devloop doctor` (B4). We reasoned about it from `verify-hmr.mjs` instead;
  the better reference is missing and should be found before building it.

## 5. `dsh-toolkit-ui` — the shell

857 lines. Its whole reason to exist: **the DSH client module loader forbids
cross-plugin runtime imports**, so plugins publish themselves into a global
registry instead.

1. **The registry contract.** `registerToolkitEntry(entry)` writes into
   `globalThis.__DSH_TOOLKIT__` and **returns a disposer**; plugins register
   inside `ctx.effect`, so unloading removes the entry. No plugin imports another.
2. **The entry is lazy and the shell never polls**: `getMetric(sessionId)`,
   `getState(sessionId)`, `renderRow` / `renderQuick` / `renderPanel`. For us
   `getState` is `running | waiting-on-gate | halted` and `getMetric` is session
   cost plus task counts — both already in `LoopState`.
3. **Presentation constraints worth copying even without their shell**: only
   `--dsw-*` tokens, respects `prefers-reduced-motion`, no business logic in the
   shell.

Their README is explicit that except `dsh-mode-boost`, no panel in that family
renders without `dsh-toolkit-ui` installed alongside — so adopting the shell
means our only graphical surface depends on a 0.2.0, MIT, Windows-verified,
unsupported package. Implement the *optional-integration* half instead: register
an entry if `__DSH_TOOLKIT__` exists, do nothing if it does not.

But note what that is. Registering a `getState` / `getMetric` entry is the
cheapest possible form of **integrate** in the build-vs-integrate fork (§0, §7
Q2). If that is the direction, much of the UI-adjacent work below is unnecessary
rather than deferred, and §7 Q2 has to be answered before any of it starts.

## 6. Repo-level practices

1. **`scripts/bundle-integrity.mjs`** parses built output and reports identifiers
   referenced but never declared anywhere. Written in response to a dated
   incident — 2026-08-19, `setToolkitOpenId` used without an import, tree-shaken
   away, silent until a user clicked Close. Its header states the deliberate
   blind spot: no scope analysis, so it under-reports and never false-positives.
   A check that names its incident and admits what it cannot see is what
   `V0.6-TODO.md` does for deferrals.
2. **`verify-hmr.mjs` verifies the install, not the build**: the profile's
   dependency really is `link:<this dir>`, `node_modules/<name>` really realpaths
   here, the running server's graph revision matches the local bundle hash. The
   shape our PATH TODO needs — not a decision about which spelling to print, but
   an inspection of what is installed on *this* machine.
3. **A fixed README section order**, held by eight of ten packages
   (`dsh-developer-toolkit` and `dsh-mode-boost` do their own thing): Why /
   Features / Install / Usage / Development / Compatibility / Privacy / Security
   / Limitations / Roadmap. Two we lack: **Security with a stated risk level**
   (per package — run-lab says High, dev-loop Medium; stating one at all is the
   practice) and **Limitations** as a section rather than prose scattered through
   the argument. Plus a Roadmap ending *"None are implemented yet."*
4. **Bilingual `README.md` / `README.en.md`** with a one-page
   `docs/ARCHITECTURE.md` — again eight of ten.
5. **A changelog section for what did *not* change** (`未改动（澄清）`), used to
   pre-empt a wrong inference from a breaking-change entry.

## 7. Ranked list

**Tier A — one theme: what the loop can honestly say happened.**

| # | Item | Source | Why now |
|---|---|---|---|
| A1 | An evidence channel for worker-produced output — capture stdout/stderr, extract the last-failure section (tail-anchored, ±8/6, budgeted), write it to an artifact the gate cites; **hold reasons stay the short stable keys they are** | §1 + dev-loop `extractLastFailSection` / `truncateOutput` | `AcceptanceFailure.detail` is `exit 1` and never leaves the logger; the naive fix kills `maxSameAction` |
| A2 | Redact secret-shaped values, and strip ANSI, before anything persists | dev-loop `log.ts` | prerequisite for A1 |
| A3 | Pass explicit `env` / `unsetEnv` on the acceptance path | our own gap | `runAcceptanceChecks` passes neither, so a check inherits `process.env` whole — API keys included — while running against code a worker wrote (`unsetEnv` exists and is used only by `forge.ts`) |
| A4 | A `session/event` usage tap for `HarnessSubagentBackend` | `dsh-debrief` `core/tokens.ts` | `BackendResult` has `tokens`/`costUsd`; the in-process backend fills neither, and this is the tier the cost cap cannot see |
| A5 | Let a gate **wait** instead of halting: queued-latest + re-entrancy beside `busy`, so an answer wakes a waiting loop rather than needing a restarted profile | dev-loop `WatchScheduler` | `V0.6-TODO.md`'s own words: a loop waiting on a gate has not halted. A halt that poses an answerable question and then kills its timer is an error with better prose |

**Tier B — 0.5 feature work, in this order.**

| # | Item | Source | Note |
|---|---|---|---|
| B1 | Named acceptance steps (`{name, argv}`, per-step `timeout`) | dev-loop | names only: no `dependsOn`, and **keep throwing** on a malformed check |
| B2 | `expectExitCode` + `expectFileExists`; JUnit counts **reported, never consulted** | run-lab `evaluator.ts` | no `regexAssertions` |
| B3 | A change-size signal | run-lab `diff.ts`, better in `dsh-time-machine` | generalizes the `empty_task` hold |
| B4 | `devloop doctor` — inspect the install, print the invocation that works here | `verify-hmr.mjs`; look for `dsh-preflight` first | closes the PATH TODO's workaround, but adds surface, so not Tier A |
| B5 | E2E: real temp git repo, real worktrees, fake backend printing fake usage | run-lab `e2e.mjs` | |
| B6 | README Security-with-risk-level and Limitations sections | repo convention | cheap; a doc chore, not a fix |
| B7 | A single containment rule with a **budget** for worker-produced text — acceptance output, REWORK feedback, PR comment bodies | `dsh-session-archaeologist` | replaces per-site constants like `MAX_DETAIL` |

**Tier C — not now, with the reason.**

| # | Item | Reason |
|---|---|---|
| C1 | `.devloop/TRUST.json` | profile config already records which commands an operator consented to and when; a second source of truth lets the loop advance while the operator believes checks are running |
| C2 | Depend on `dsh-toolkit-ui` | unsupported 0.2.0 as our only GUI; implement the optional registry contract, adopt Output Gallery's artifact-rendering rules if a panel ever ships, keep `devloop status` |
| C3 | Repeat-N in the loop | blocked on task claims and leases, which `V0.6-TODO.md` deferred for want of a consumer; repeat-N is that consumer — see Q4 |
| C4 | Copy isolation | no git analogue for scope-check, commit, `baseSha` binding or `empty_task`; the arena requires a repo |
| C5 | `compare()` winner scoring | unweighted counting presented as judgment, and there is no gate option that means "take branch B" |
| C6 | HTTP API + `trustedRequest` | no HTTP surface; worth copying the day there is one |
| C7 | Shell-string commands anywhere | our argv path must survive B1/B2 — and note it is POSIX-only today: `spawnCli` routes through `cmd.exe /d /v:off /s /c` on Windows |

## 8. Provenance

Their code is MIT; this repo is Apache-2.0, which can carry MIT files with the
notice retained — but nothing above requires copying one. Every item is a shape:
a return type, a truncation strategy, a config key set, an event subscription.
Reimplement, and credit the source in `docs/` the way `V0.6-TODO.md` credits
LongHorizon-Harness and LoopX. Verbatim copies would need the MIT header and a
NOTICE entry.

## 9. Open questions

1. **What is the containment rule for worker-produced text?** One rule with a
   budget, covering acceptance output, REWORK feedback carried into the next
   attempt, and PR comment bodies — not a constant per call site. Blocks A1 and
   B7.
2. **Build 0.5, or emit and integrate?** `dsh-run-lab` ships our arena and
   `dsh-debrief` ships our usage feed. Emitting `session/event`-shaped data and
   registering a toolkit entry is a few dozen lines; building the equivalents is
   most of a release. Answer this before any UI-adjacent work starts.
3. **Should T1/T2 dispatch in process (`ctx.subagents` + `session/event`) rather
   than as one-shot CLIs?** It is the only path by which `maxCostUsdPerDay` sees
   the tier that spends the most, and it trades the fresh-process-per-task
   isolation the README leans on for observability. An architecture fork, not a
   TODO line.
4. **Repeat-N is a concurrency question, not a budget one.** The service runs one
   dispatch at a time behind `busy`, and `resolveConfig` clamps
   `taskLifetimeMinutes` to `taskTimeoutMinutes × maxTaskAttempts`. N serialized
   samples at 45 minutes each is a wall-clock problem no budget line fixes; N
   parallel samples needs claims and leases first.

## 10. What the review changed

The first draft was fact-checked against source and design-reviewed against this
repo's committed principles. Ten factual corrections were applied (the ones worth
naming: `assertSafePath` is dead code in their own tree, not live behavior;
`repeat.ts` aggregates while `engine.ts` runs; eight of ten packages hold the
README convention, not all ten; `bundle-integrity.mjs` cites a dated incident but
does not date itself). Three conclusions reversed:

- **A trust store moved from Tier A to C1.** It borrows a ceremony for a threat
  we do not have and introduces a second source of truth for whether acceptance
  runs.
- **The acceptance fix was rescoped.** The first draft proposed carrying output
  onto the rejection, which would have fed nondeterministic text into
  `actionKey` and disabled `maxSameAction` and the no-progress latch.
- **`dsh-debrief` was missing entirely**, and it mechanically solves what the
  first draft answered with a comment convention.

Also promoted: gates that wait rather than halt (A5), from a footnote about watch
mode to the item that finishes what 0.4.1 started. Also cut: copy isolation, and
`regexAssertions`.
