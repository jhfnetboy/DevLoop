# DevLoop

DeepSeek Harness plugin: **expensive models plan and review, cheap models implement, a program loop keeps the factory inside budget.**

This repository is `dsh-devloop`. It is not another coding agent and it does not fork DSH core. Design and decisions: [docs/](https://github.com/jhfnetboy/DevLoop/tree/main/docs).

## What 0.3.0 does

- Advances the bounded plan → delegate → review → local merge pipeline from validated, versioned model results
- Adds a human snapshot at `.devloop/PROGRESS.md` after each tick (including latched idle, killSwitch, and unreadable STATE)
- Each dispatch is a new one-shot CLI; at most one in flight (`busy`). The next tick waits.
- Optional `tokens` / `costUsd` from the backend fold into budget usage when present; session cost resets when the plugin starts; daily cost resets at UTC midnight
- Still no operator UI (**0.4**)
- Installs into a DSH profile as a bundle plugin
- On each tick, if the workspace has `.devloop/GOAL.md`, reads revisioned state and deterministically chooses plan / delegate / review / merge / stop
- Enforces budget / circuit-breaker rules in-process
- Does **not** spawn workers by default (`agentBackend: noop`). Opt in to one fixed CLI, or use `agentBackend: routed` for role/tier routing.
- After writing STATE, plan / delegate / review is handed to `AgentBackend.run` outside the lock; validated results are committed in a second revision-checked transition
- `delegate` creates `.devloop/worktrees/<taskId>` and writes `.devloop/CONTRACT.json` inside it
- With `agentBackend: routed`, plan uses `plannerRoute`, delegate uses `routing[contract.tier]`, and review uses the independent `reviewerRoute`
- `merge` is mechanical git: `merge_ready` plus Review `PASS` / `PASS_WITH_NOTES` merges `devloop/<taskId>` into workspace HEAD, deletes the worktree, marks the task `done`. No PASS → escalate. Does not push. Does not call AgentBackend.

Install: [`docs/Install.md`](./docs/Install.md). This cut: [`docs/Release.md`](./docs/Release.md).
Multi-model architecture choices and the recommended Harness-native path: [`docs/OrchestrationOptions.md`](./docs/OrchestrationOptions.md).

## Product target (not all shipped)

The expensive-vs-cheap split is from [`docs/Solution.md`](./docs/Solution.md). The T3 CLI split matches [`docs/CONTEXT.md`](./docs/CONTEXT.md) and ADR-0005: Codex leans Supervisor / scheduling; Claude leans architecture and key review. Image / video models (Qwen image, Wan, etc.) are **out of this loop**.

| Role | Who | Job | When |
|---|---|---|---|
| T3 Supervisor / plan | Codex CLI (`codex exec`) | `/plan`, scheduling, adversarial planning | **0.3** (`plannerRoute`) |
| T3 architecture / key review / acceptance | Claude Code CLI (`claude -p`) | Architecture, key review, acceptance | **0.3** (`reviewerRoute`) |
| T1 / T2 implement | DSH + DeepSeek Flash / V4 Pro | Diffs, tools, bounded code changes **from** the T3 plan | **0.3** (`routing[contract.tier]`) |
| Optional T2 stand-ins | GLM / Kimi / other APIs already in DSH | Same worker tier, not a new runtime | config later |
| Outer loop | This plugin | 24h tick, budget, self-iteration — not one unbounded chat | **0.3** |

Routing is opt-in. The safe default remains `noop`; fixed `dsh` / `claude` / `codex` modes remain for compatibility.

**Secondary development:** DSH tree-outside plugin (do not fork Harness). Ideas from community `dsh-devflow`; this repo is a rebuild, not a copy.

## Progress vs that target

**0.3 is this slice.** Unattended scheduler heartbeat, one-shot dispatch, and PROGRESS.md. Stacked on 0.2.6 (PR #14); 0.2.5 is on `main` (PR #12). T3 git/host-commit is not in this diff.

| Slice | Status | Meaning |
|---|---|---|
| 0.1.x | **Done** (on `main`) | Installable plugin, deterministic loop, budget, `.devloop/STATE.json` |
| 0.2.1 | **Done** | `AgentBackend` after lock; production default `noop` |
| 0.2.2 | **Done** | Worktree + frozen Task Contract |
| 0.2.3 | **Done** (tag `v0.2.3`) | Opt-in `dsh --profile headless`; same command for plan/delegate/review; no tier split |
| **0.2.4** | **Done** (PR #11 on `main`) | Mechanical merge only after Review PASS; then delete worktree |
| **0.2.5** | **Done** (PR #12 on `main`) | Spawn `claude` / `codex` as T3; DSH Flash/Pro remain T1/T2 |
| **0.2.6** | **Open** (PR #14) | Host commit, Claude `--`, Codex gitdir |
| **0.3** | **This slice** | Continuous scheduler ticks, role/tier routing, one-shot dispatch, budget signals, PROGRESS.md |
| **0.4** | **Not started** | Operator UI / human queue / budget panel — **not** required for the autonomous loop |

Path to the goal you described:

```text
v0.2.3
  → 0.2.4 mechanical merge          # on main (PR #11)
  → 0.2.5 Claude + Codex T3 CLIs    # on main (PR #12)
  → 0.2.6 T3 harden                 # host commit (PR #14)
  → 0.3 unattended scheduler        # this slice: continuous bounded ticks
```

Each slice is its own stacked PR. 0.2.4 (PR #11) and 0.2.5 (PR #12) are on `main`; this 0.3 PR stacks on 0.2.6 (PR #14). **0.4 is a later operator surface**, after the loop can already run.

## How it fits

```mermaid
flowchart LR
    You[You] --> Goal[GOAL.md]
    Goal --> Plugin[dsh-devloop plugin]
    Plugin --> DSH[DeepSeek Harness]
    DSH -->|opt-in headless| Workers[T0 T1 T2 workers]
    Plugin -->|STATE| State[".devloop/STATE.json"]
    Plugin -->|escalate| You
```

Harness is the agent runtime. This plugin is the engineering scheduler. Default `noop` only writes the next action. Opt-in `dsh` / `claude` / `codex` spawn one-shot CLIs. Merge is mechanical git after Review PASS.

## Tick (what ships now)

```mermaid
flowchart TB
    Timer[Cordis timer] --> Armed{GOAL.md present?}
    Armed -->|no| Idle[skip write]
    Armed -->|yes| Lock[withStateLock]
    Lock -->|held| Skip[skip this beat]
    Lock --> Decide["decideNextAction(state) no LLM"]
    Decide --> Budget["evaluateBudget(limits, now)"]
    Budget -->|trip| Stop[stop plus killSwitch]
    Budget -->|ok| Latch{same work action?}
    Latch -->|yes| Skip
    Latch -->|no| Write[write STATE.json]
    Stop --> Write
```

`decideNextAction` only sees state. Cost / timeout / attempt caps are applied afterwards in `runTick`, so a budget trip can rewrite any intended action into `stop`.

## Target factory (0.2 and later)

```mermaid
flowchart TB
    You[You] --> Goal[GOAL.md]
    Goal --> Runtime[dsh-devloop plugin]
    Runtime --> SM[Deterministic loop]
    SM -->|plan| T3[T3 Supervisor]
    SM -->|delegate| Workers
    SM -->|review| Reviewers
    SM -->|merge| Merge[Mechanical merge]
    SM -->|escalate| You

    subgraph Workers
      T0[T0 local cheap]
      T1[T1 DSH plus DeepSeek Flash]
      T2[T2 DSH plus DeepSeek Pro]
    end

    subgraph Reviewers
      R1[T1 reviews T0]
      R3[Higher tier than implementer]
    end

    Workers --> WT[Git worktrees]
    WT --> Reviewers
    Reviewers -->|PASS| Merge
    Reviewers -->|REWORK| Workers
    Merge --> Progress[PROGRESS.md]
    Progress --> SM
```

In routed mode, plan / delegate / review use independent configured routes. Merge lands git locally and does not push.

## Can 0.3 meet the product goal?

The goal is: expensive models plan and review, cheap models implement, a program loop keeps the factory inside budget.

| Goal slice | 0.3.0 |
|---|---|
| DSH plugin, not a new runtime | Yes. Bundle + Cordis Service. |
| Program loop, one transition per tick | Yes. Pure `decideNextAction` plus `runTick`, driven by `setInterval`. |
| Hard budget / kill switch | Yes, in-process. Live token/cost only if the backend fills `AgentRunResult`. |
| File-backed recoverability | `GOAL.md` + revisioned `STATE.json` + append-only `EVENTS.jsonl` + `LOCK` + `PROGRESS.md` + worktree `CONTRACT.json`. |
| Cheap workers actually implement | Yes when opted in. Routed mode selects `routing[contract.tier]`; the host validates changed paths and creates the commit. |
| Expensive models actually review | Yes when opted in. Review is bound to the implementation SHA and an independent provider/model identity. |
| Unattended milestone completion | Yes for the bounded plan → delegate → review → local merge chain; push and release remain explicit operator actions. |

0.3 advances the bounded pipeline from validated machine results under budget. The operator UI, general API broker, and pstack-style multi-candidate arena remain 0.4.

## Requirements

- Node `^22.19.0 || >=24.0.0` (DSH engines; Node 23 is not in the Harness range)
- pnpm
- DeepSeek Harness CLI (`npm i -g @deepseek-ai/dsh` or `pnpm dsh` from a harness checkout)
- A working `dsh web` (or any profile you want the plugin in)

## Build

```bash
pnpm install
pnpm test
pnpm build
```

Git installs run `prepare` → `pnpm build`, so the published entry is `lib/`.

## Install into DSH

Pinned GitHub tag (needs git tag `v0.3.0`; until then `github:jhfnetboy/DevLoop`). Git install runs `prepare` → `pnpm build`. pnpm ≥10 may ignore that build and still exit 0 — if it prints `Ignored build scripts`, approve `dsh-devloop` (`onlyBuiltDependencies` on pnpm 10.1–10.25, `allowBuilds` on ≥10.26, or `pnpm approve-builds`) and re-run `add` (not `pnpm rebuild`), even when `add` succeeded:

Quote the spec: zsh treats `#` as a glob (`no matches found`).

```bash
dsh plugin --profile web add 'github:jhfnetboy/DevLoop#v0.3.0'
```

From this checkout (after `pnpm build`):

```bash
dsh plugin --profile web add /absolute/path/to/DevLoop
```

Full operator steps: [`docs/Install.md`](./docs/Install.md).

Restart the profile:

```bash
dsh web
```

Confirm the layer is composed:

```bash
dsh --profile web --dump-config | grep -A2 devloop
```

You should see a `# == dsh-devloop` layer and an inserted row `id: devloop`.

Optional overrides in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: devloop
  config:
    root: /path/to/your/project
    tickIntervalMs: 2000
    agentBackend: routed
    plannerRoute: { tier: T3, backend: codex, model: gpt-5.4 }
    reviewerRoute: { tier: T3, backend: claude, model: opus }
    budget:
      maxCostUsdPerDay: 20
      taskTimeoutMinutes: 45
      taskLifetimeMinutes: 135
```

`agentBackend` defaults to `noop` (no spawn). Routed defaults require `dsh`, `claude`, and `codex` on PATH; override routes to match the installed adapters.

## Arm a project

The plugin is idle until the target workspace contains `.devloop/GOAL.md` (a regular file). A bare `.devloop/` directory does not arm it.

```bash
mkdir -p /path/to/your/project/.devloop
# after plugin install:
cp ~/.dsh/profiles/web/node_modules/dsh-devloop/templates/GOAL.md \
  /path/to/your/project/.devloop/GOAL.md
# from a local checkout, use templates/GOAL.md instead
# edit GOAL.md, then start dsh from that project (or set config.root)
```

Each tick writes `.devloop/STATE.json`, appends `.devloop/EVENTS.jsonl`, and updates `PROGRESS.md`. With `agentBackend: noop` (default) it does not edit source. `dsh` / `claude` / `codex` run that CLI in the worktree; `subagent:<provider>` reuses an installed Harness provider.

## Uninstall

```bash
dsh plugin --profile web remove dsh-devloop
```

## Reference implementations (not vendored)

Local clones used while writing 0.1 (outside this repo):

- `deepseek-ai/deepseek-harness` — plugin / bundle API
- `H97y/dsh-devflow` — winner reference for tick + worktree + pipeline ideas

We rebuild; we do not copy that product’s requirement-pool model.

## License

Apache-2.0. DSH and `dsh-devflow` are MIT; we depend on their public plugin API only.
