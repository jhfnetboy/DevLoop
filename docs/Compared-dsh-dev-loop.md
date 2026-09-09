# Measured against dsh-dev-loop

[`dsh-dev-loop`](https://github.com/nzl153/dsh-devtools/tree/main/packages/dsh-dev-loop)
is the package whose name npm judged too close to ours, which is how we came to
read it. It is a DSH plugin, it is called a dev loop, and it is not the same
thing at all — which makes it worth reading rather than dismissing.

It is a **panel a person drives**: buttons for Build / Test / Package / Run,
streamed output, exit code and duration, cancel, and a "send the last failure to
the Agent" button. This is a **loop that runs unattended**: plan → delegate →
review → merge, with the host owning state and models only proposing.

It answers "give me a button for the thing I keep retyping". We answer "stop
needing me to watch". Both run operator-configured commands from the workspace,
which is where the overlap is, and where it has thought about things we had not.

## What it has that we do not

### A trust boundary, not just a default-off switch

`acceptance` runs code a worker wrote. Our answer is that it ships empty and the
README states the cost plainly. Theirs is stronger: the command list comes from
the workspace, and the **first execution for a project asks a person**, with the
answer persisted per project root in `~/.dsh/dev-loop/trust.json` as
`{root, name, confirmedAt}`.

The difference is not paranoia, it is shape. Default-off pushes the decision
into configuration once; after that the switch is on for ever and for every
project. Theirs asks again for each new root, and leaves a record of who agreed
and when. Ours cannot answer "who turned this on"; theirs can.

Worth taking. It fits our design rather than fighting it: the host already
refuses to let a model choose what runs, and a trust record is the same
statement written down.

### Tolerant reads for advisory data

Their trust store treats a corrupt `trust.json` as empty and carries on. We do
the opposite everywhere: `isLoopState` rejects, which becomes an `invalid_state`
integrity hold — the one halt no answer can lift.

For `STATE.json` that is right; it is the loop's authority. But we apply the
same severity to everything, and this session already found the cost of that in
another place: validating `acknowledged`, a field no code branches on, would
have meant a corrupt cosmetic value bricking the workspace. **Strictness should
follow what the data is load-bearing for.** They separated the two; we have not,
beyond that one deferred decision.

### An operator surface, which we have deliberately not built

`export const inject = ['webServer']` in the host half, `dsh.client.platform:
"web"` in `package.json`, and `src/host/` beside `src/client/Panel.tsx`. The
same repo also ships `dsh-toolkit-ui`, "UI shell and shared presentation layer".

Our 0.5 milestone is exactly this and nothing has been designed for it yet. The
mounting is the part not worth inventing twice.

### A stance we should read carefully

> After Agent Turn（默认关闭）：Agent 完成一轮后自动执行指定 action；**失败只显示 FAIL，不自动让 Agent 无限修**

They can run a check after an agent turn, and they refuse to feed the failure
back into an automatic repair. Our loop is that automatic repair. We do not
think they are right — a bounded loop with real circuits is the thing we are
building — but their reason is the risk we actually carry, and this session is
evidence for it: **every serious bug found in 0.4.0 was a circuit that had
stopped counting.** `review` clearing `reviewCycles`; a refund netting
`taskAttempts` to zero; a refusal counter that outlived its task and hid the
live reason. Three different ways for the brake to be there and not connected.

Their answer is to not enter the room. Ours is to enter it and instrument the
brakes — which obliges us to test the brakes, at the second tick and not only
the first.

## What we checked and did not need

Two things looked like gaps and were not. Both were written into a draft of this
document as findings before being checked, which is the reason for writing them
down here as corrections.

**Unbounded output.** They cap accumulated output at 200k characters. We were
about to record this as something we lack. `spawn.ts` sets
`MAX_SPAWN_BUFFER = 10 * 1024 * 1024` and enforces it by destroying both streams
on overflow (`src/spawn.ts`), so ours is bounded too — an order of magnitude
looser, for a different purpose: theirs is what a human reads in a panel, ours
is what a process may hold before being killed.

**Secrets reaching committed state.** They redact values of `env` keys matching
`KEY/TOKEN/SECRET/PASSWORD` from displayed output. The draft claimed our
acceptance failures write command output into `STATE.json` and `EVENTS.jsonl`,
which are committed — a permanent leak from one `printenv` in a test suite.
That is false. A failed check rejects with `exit ${code}`; the child's stdout
and stderr are **discarded**, never attached to the error, never stored. Our
`acceptance` also takes no `env`, so the vector they redact does not exist here.

The residual risk is narrower and real: the **argv itself** is recorded, in the
hold reason (`acceptance_failed: <argv>`) and in the gate's evidence, both of
which reach `EVENTS.jsonl`. An operator who writes a credential into a check —
`["curl", "-H", "Authorization: Bearer …"]` — commits it. That is worth a line
in the docs where `acceptance` is configured, and it is a smaller claim than the
one this document nearly made.

## Ordered by what it would buy

1. **Trust record for `acceptance`** — replaces "configured once, on for ever"
   with "asked per project, and recorded". Closes the "who turned this on"
   question we cannot currently answer.
2. **Warn that argv is committed** — one line where `acceptance` is documented.
   Cheap, and the only item here with an irreversible failure mode.
3. **Severity that follows the data** — tolerant reads for advisory files,
   strict only for the loop's authority. Currently one deferred decision rather
   than a rule.
4. **0.5 operator surface** — borrow the mounting, not the product.

Nothing here is a defect in what shipped in 0.4.1.
