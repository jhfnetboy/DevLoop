# Multi-model Orchestration Options

## Design constraints

DevLoop should own scheduling, state transitions, budgets, retries, worktree isolation, and acceptance gates. Models provide bounded planning, implementation, or review results; no model is the durable source of truth. A cheap model may propose routing and task breakdown, but it must not be the sole authority that both assigns and accepts its own work.

The DeepSeek Harness references suggest four rules:

- Use Cordis services and effect-scoped registrations rather than hard-wiring another runtime.
- Treat model runners as named providers with declared capabilities and fail before side effects when a requirement is unsupported.
- Separate durable state from process-local activation. Persist revisions and outcomes, not live handles.
- Give every accepted run one owner that always cancels/disposes it and waits for quiescence.

Pstack adds the operating discipline: design important boundaries with competing candidates, isolate parallel writers, sequence verifiable units, prove behavior with real artifacts, and retain a compact evidence trail.

## Option A — Native Harness providers (recommended)

DevLoop remains a deterministic Cordis control-plane plugin and dispatches through the Harness subagent service:

    DevLoop state machine
      plan       -> provider: codex-planner
      delegate   -> provider selected by task tier
      review     -> provider: claude-reviewer (different identity)
      acceptance -> host tests + independent verdict

Use named ctx.subagents providers such as dsh-sdk, claude-code, codex, or ACP. DevLoop supplies the task contract, cwd, cancellation signal, and route; the provider owns process startup, environment scrubbing, native protocol handling, result mapping, and teardown.

Advantages:

- Smallest duplication of Harness behavior.
- Local Claude Code and Codex subscriptions/settings remain authoritative.
- Provider capability checks and lifecycle rules already exist.
- Kimi/GLM can enter through a future provider without changing the scheduler.

Costs:

- Current provider packages are pre-release and some features, including per-call model selection and structured output, vary by provider.
- DevLoop still needs its own durable project/task state and worktree merge policy.

## Option B — Workflow/Ralph inner loop

Keep DevLoop as the durable outer scheduler, but use workflowEngine for bounded fan-out and the Ralph pattern for fresh-agent iteration. A task can run multiple isolated attempts and return one validated handoff.

Advantages:

- Reuses concurrency caps, cancellation, child ownership, and structured workflow results.
- Fits pstack's arena/swarm patterns for expensive design or adversarial review.
- Keeps verbose child contexts out of the coordinator context.

Costs:

- Harness workflows currently have no journaling/resume and no aggregate token/cost vocabulary.
- Ralph completion is a worker report, not independent certification.
- Worktree allocation and merge remain DevLoop responsibilities.

Use this as an optional execution strategy inside Option A, not as the only control plane.

## Option C — API broker plus CLI specialists

DevLoop calls an OpenAI-compatible or Anthropic-compatible API adapter for cheap work and invokes Harness Claude/Codex providers for high-risk planning and acceptance.

Example policy:

- T0: deterministic scripts, formatters, search, generated checks.
- T1: DeepSeek Flash for triage, docs, narrow tests, mechanical edits.
- T2: DeepSeek Pro, Kimi, or GLM for debugging and medium refactors.
- T3: Codex/Claude for architecture, security-sensitive work, and final review.

Advantages:

- Lowest marginal cost and widest provider choice.
- API usage responses can feed exact token and cost accounting.
- Straightforward health, quota, and fallback routing.

Costs:

- DevLoop must own API compatibility, tool execution, credential policy, rate limits, and response validation.
- Coding-plan subscriptions may restrict unsupported third-party automation; supported CLI integration or ordinary API billing is safer.

## Option D — Model-led coordinator

A cheap DeepSeek session reads the queue and calls local Claude/Codex tools. This is easy to demo and resembles PR-Daemon, but the model becomes an implicit state machine.

It is acceptable as an interactive convenience layer, not as the durable authority. Long runs become sensitive to context drift, self-review, repeated side effects, and incomplete recovery.

## Recommended 0.3 scope

Build Option A's narrow end-to-end spine:

1. Replace free-form backend completion with a versioned result envelope: status, summary, evidence, changed paths, tests, usage, and blocker.
2. Route by role and task tier to named providers; record the resolved provider identity and model with the run.
3. Persist append-only task/run events with revision checks; derive the current snapshot for operators.
4. Enforce allowed paths from the host diff, not only in the prompt.
5. Advance one task through delegate -> review -> merge automatically; bind review to the exact task commit SHA.
6. Require mechanical acceptance plus an independent reviewer for medium/high risk.
7. Keep noop as the safe default and expose provider health/configuration failures clearly.

Defer adaptive routing, parallel task DAG execution, mailbox/team semantics, and UI to later releases. Option B can then provide arena or Ralph execution for selected high-value tasks, while Option C adds Kimi/GLM through explicit providers without changing the state machine.
