import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../src/command.ts'
import { resolveConfig } from '../src/config.ts'
import { applyAnswer, gateFor } from '../src/gate.ts'
import { emptyState, loadState, saveState } from '../src/persist.ts'
import type { LoopState } from '../src/types.ts'
import { baseState, makeTask, mkdtempInRepo, withTasks } from './helpers.ts'

const limits = resolveConfig({}).budget
const NOW = 1_000_000
const SHA = 'a'.repeat(40)

function held(reason: string, task: Partial<Parameters<typeof makeTask>[0]> = {}): LoopState {
  return {
    ...withTasks(baseState(), [makeTask({ id: 'A', status: 'merge_ready', ...task } as never)]),
    killSwitch: true,
    lastAction: { type: 'stop', reason: 'budget' },
    supervisor: { taskId: 'A', reason },
  }
}

describe('gateFor', () => {
  it('asks nothing of a loop that is running', () => {
    const state = withTasks(baseState(), [makeTask({ id: 'A', status: 'ready' })])
    expect(gateFor({ ...state, usage: { ...state.usage, lastProgressAt: NOW } }, limits, NOW)).toBeNull()
  })

  it('turns a hold into a question with answers the loop can act on', () => {
    const gate = gateFor(held('empty_task', { lastReviewVerdict: 'PASS' }), limits, NOW)
    // The reason is kept, but it is no longer all the operator gets.
    expect(gate?.reason).toBe('empty_task')
    expect(gate?.question).toMatch(/\?$/)
    expect(gate?.evidence.length).toBeGreaterThan(0)
    expect(gate?.options.map(o => o.key)).toEqual(['retry', 'accept', 'stop'])
  })

  it('says what each answer costs before it is chosen, and recommends one unless the only answer is to leave it', () => {
    const cost = {
      // Not a clean slate: the worker runs again in the same worktree, on the same base.
      retry: { spends: true, discards: false },
      review: { spends: true, discards: false },
      accept: { spends: false, discards: false },
      stop: { spends: false, discards: false },
    }
    for (const reason of ['empty_task', 'no_review_pass', 'stale_review_sha', 'blocked_task', 'prepr_blocked:B2', 'task_over_budget:300 lines, 7 files', 'security_high_risk', 'daily_cost_cap']) {
      const g = gateFor(held(reason), limits, NOW)!
      for (const option of g.options) expect(option.impact, `${reason} ${option.key}`).toEqual(cost[option.key])
    }
    expect(gateFor(held('empty_task'), limits, NOW)?.recommended).toBe('retry')
    expect(gateFor(held('no_review_pass'), limits, NOW)?.recommended).toBe('review')
    // Nothing to recommend where leaving it is the only answer: what to do is in `manual`.
    expect(gateFor(held('task_over_budget:300 lines, 7 files'), limits, NOW)?.recommended).toBeNull()
    expect(gateFor({ ...baseState(), killSwitch: true, supervisor: { taskId: null, reason: 'invalid_state' } }, limits, NOW)?.recommended).toBeNull()
  })

  it('names its family and the values its sentences use, for a page to ask it in another language', () => {
    expect(gateFor(held('task_over_budget:300 lines, 7 files'), limits, NOW)).toMatchObject({
      key: 'task_over_budget', vars: { task: 'A', detail: '300 lines, 7 files', reason: 'task_over_budget:300 lines, 7 files' },
    })
    expect(gateFor(held('no_review_pass', { lastReviewVerdict: 'REWORK' }), limits, NOW)).toMatchObject({ key: 'no_review_pass', vars: { verdict: 'REWORK', detail: '' } })
    expect(gateFor(held('max_review_cycles:A'), limits, NOW)?.vars.cycles).toBe(String(limits.maxReviewCycles))
    expect(gateFor(held('escalate:something_new'), limits, NOW)?.key).toBe('generic')
    expect(gateFor({ ...baseState(), killSwitch: true, supervisor: { taskId: null, reason: 'invalid_state' } }, limits, NOW)).toMatchObject({ key: 'integrity', vars: { reason: 'invalid_state' } })
  })

  it('offers a re-review, not a redo, when the verdict is the problem', () => {
    for (const reason of ['no_review_pass', 'stale_review_sha', 'reviewer_identity_conflict']) {
      const keys = gateFor(held(reason), limits, NOW)?.options.map(o => o.key)
      expect(keys, reason).toContain('review')
    }
  })

  it('offers no automated answer where none would help', () => {
    // Policy sends this to a person; there is no reply that changes that.
    const risky = gateFor(held('security_high_risk', { risk: 'high' }), limits, NOW)
    expect(risky?.options.map(o => o.key)).toEqual(['stop'])
    expect(risky?.manual).toMatch(/by hand|merge it by hand|lower the risk/i)

    // A cap is a decision, so nothing here clears it on its own.
    const capped = gateFor(held('daily_cost_cap'), limits, NOW)
    expect(capped?.options.map(o => o.key)).toEqual(['stop'])
    expect(capped?.manual).toContain('--reset-cost')
  })

  it('refuses to speak for a state it could not read', () => {
    const corrupt: LoopState = {
      ...baseState(),
      killSwitch: true,
      supervisor: { taskId: null, reason: 'invalid_state' },
    }
    const gate = gateFor(corrupt, limits, NOW)
    expect(gate?.options.map(o => o.key)).toEqual(['stop'])
    expect(gate?.manual).toMatch(/STATE\.json/)
    // Saying "retry" here would write a synthesised empty loop over real history.
    expect(gate?.taskId).toBeNull()
  })

  it('names the budget it hit, and how many attempts that was', () => {
    const gate = gateFor(held('max_task_attempts:A', { status: 'ready' }), limits, NOW)
    expect(gate?.evidence.join(' ')).toContain(String(limits.maxTaskAttempts))
    expect(gate?.options.map(o => o.key)).toEqual(['retry', 'stop'])
  })

  it('still asks something useful for a reason it does not know', () => {
    const gate = gateFor(held('some_future_reason'), limits, NOW)
    expect(gate?.reason).toBe('some_future_reason')
    expect(gate?.evidence.join(' ')).toContain('some_future_reason')
    expect(gate?.options.map(o => o.key)).toEqual(['retry', 'stop'])
  })
})

describe('applyAnswer', () => {
  const gate = (reason: string, task: Record<string, unknown> = {}) =>
    gateFor(held(reason, task as never), limits, NOW)!

  it('refuses an answer the question did not offer', () => {
    const risky = gate('security_high_risk', { risk: 'high' })
    expect(() => applyAnswer(held('security_high_risk', { risk: 'high' } as never), risky, 'retry', NOW))
      .toThrow(/not an answer to this question/)
  })

  it('leaves everything alone for stop, and records that a person said so', () => {
    const state = held('empty_task')
    const next = applyAnswer(state, gate('empty_task'), 'stop', NOW)
    // Everything that drives the loop is identical...
    expect({ ...next, acknowledged: undefined, updatedAt: state.updatedAt })
      .toEqual({ ...state, acknowledged: undefined })
    // ...and the decision itself is now a fact rather than terminal output.
    expect(next.acknowledged).toMatchObject({ reason: 'empty_task', taskId: 'A' })
  })

  it('sends the task back to a worker for retry', () => {
    const state = held('empty_task', { attempts: 3, lastReviewVerdict: 'PASS' })
    const next = applyAnswer(state, gate('empty_task'), 'retry', NOW)
    expect(next.tasks[0]).toMatchObject({ status: 'rework', attempts: 0 })
    expect(next.tasks[0]?.lastReviewVerdict).toBeUndefined()
    expect(next.supervisor).toBeNull()
    expect(next.killSwitch).toBe(false)
  })

  it('keeps the existing commit when the answer is to review it again', () => {
    const state = held('no_review_pass', { implementationSha: SHA, lastReviewVerdict: 'REWORK' })
    const next = applyAnswer(state, gate('no_review_pass', { implementationSha: SHA }), 'review', NOW)
    expect(next.tasks[0]).toMatchObject({ status: 'review_pending' })
    // The work is not thrown away; only the verdict is.
    expect(next.tasks[0]?.implementationSha).toBe(SHA)
    expect(next.tasks[0]?.lastReviewVerdict).toBeUndefined()
  })

  it('marks the task done only when the operator says it needed no change', () => {
    const state = held('empty_task', { lastReviewVerdict: 'PASS', reviewNotes: 'Split the parser out.' })
    const accepted = applyAnswer(state, gate('empty_task'), 'accept', NOW).tasks[0]
    expect(accepted?.status).toBe('done')
    // Done is done: no attempt follows to use a review's requests.
    expect(accepted?.reviewNotes).toBeUndefined()
    // accept is offered nowhere else, so no other halt can reach that status.
    for (const reason of ['no_review_pass', 'scope_violation', 'blocked_task', 'max_task_attempts:A']) {
      expect(gate(reason).options.map(o => o.key), reason).not.toContain('accept')
    }
  })

  // Both directions, on purpose: asserting only that `review` keeps the
  // counters would also pass for a fix that stopped clearing them for `retry`,
  // which is the one answer whose whole meaning is a fresh budget.
  it('keeps the budget for an answer that keeps the work, and clears it for one that does not', () => {
    const spent = held('stale_review_sha', { implementationSha: SHA, attempts: 2, reviewCycles: 2 })
    const state: LoopState = {
      ...spent,
      usage: {
        ...spent.usage,
        taskAttempts: { A: 2 },
        reviewCycles: { A: 2 },
        tokens: { A: 5_000 },
        taskStartedAt: { A: NOW - 60_000 },
      },
    }

    const reviewed = applyAnswer(state, gate('stale_review_sha', { implementationSha: SHA }), 'review', NOW)
    expect(reviewed.usage.reviewCycles.A).toBe(2)
    expect(reviewed.usage.taskAttempts.A).toBe(2)
    expect(reviewed.usage.tokens.A).toBe(5_000)
    // The one that cannot be rebuilt: only a delegate ever writes it back, so a
    // task answered into review would leave the lifetime circuit for good.
    expect(reviewed.usage.taskStartedAt.A).toBe(NOW - 60_000)
    expect(reviewed.tasks[0]).toMatchObject({ status: 'review_pending', attempts: 2, reviewCycles: 2 })
    expect(reviewed.supervisor).toBeNull()

    const retried = applyAnswer(state, gate('stale_review_sha', { implementationSha: SHA }), 'retry', NOW)
    expect(retried.usage.reviewCycles.A).toBeUndefined()
    expect(retried.usage.taskAttempts.A).toBeUndefined()
    expect(retried.usage.taskStartedAt.A).toBeUndefined()
    expect(retried.tasks[0]).toMatchObject({ status: 'rework', attempts: 0, reviewCycles: 0 })
  })

  it('answers a request to replan with a plan change, not another identical run', () => {
    const g = gate('review_requested_replan')
    expect(g.options.map(o => o.key)).toEqual(['stop'])
    expect(g.question).toMatch(/plan/i)
    // Not PLAN.md: nothing reads it back. A redo from the base is what changes something.
    expect(g.manual).toContain('git worktree remove --force')
  })

  // The complaint was never about typos at the write sites; it was that a hold
  // with no question reaches an operator as "the loop stopped and needs a
  // decision". These two were doing exactly that, written by
  // `transitionFailureReason` and answered by nobody.
  it('has a real question for every reason this repo writes', () => {
    const generic = 'The loop stopped and needs a decision'
    for (const reason of [
      'invalid_agent_result', 'result_transition_failed', 'backend_failed',
      'parent_commit_failed', 'missing_review_worktree', 'missing_agent_result',
      'acceptance_failed:pnpm test', 'dispatch_refused:A', 'task_timeout:A',
      'no_progress', 'duplicate_action:delegate:A',
    ]) {
      const g = gate(reason)
      expect(g.question, reason).not.toContain(generic)
      expect(g.evidence.length, reason).toBeGreaterThan(0)
    }
  })

  // The fallback still exists, and should: `stop:*`, `escalate:*` and a resume
  // that refused are open strings no closed family covers.
  it('still falls back for a reason no code here writes', () => {
    expect(gate('escalate:something_new').question).toContain('needs a decision')
  })

  it('refuses an answer that needs a task when the halt names none', () => {
    const corrupt: LoopState = { ...baseState(), killSwitch: true, supervisor: { taskId: null, reason: 'invalid_state' } }
    const g = gateFor(corrupt, limits, NOW)!
    expect(() => applyAnswer(corrupt, { ...g, options: [{ key: 'retry', summary: 'x', impact: { spends: true, discards: false } }] }, 'retry', NOW))
      .toThrow(/names none/)
  })
})

describe('the answer command', () => {
  const scratch: string[] = []
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function armed(state: LoopState): Promise<string> {
    const root = await mkdtempInRepo('devloop-gate-')
    scratch.push(root)
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await saveState(root, state)
    return root
  }

  it('prints the question and the exact commands that answer it', async () => {
    const root = await armed({ ...emptyState(NOW), ...held('empty_task', { lastReviewVerdict: 'PASS' }) })
    const result = await runCli(['status', root], { invokedAs: 'devloop' })
    expect(result.code).toBe(1)
    expect(result.out).toContain('Did it need any change?')
    expect(result.out).toContain(`devloop answer retry  ${root}`)
    expect(result.out).toContain(`devloop answer accept ${root}`)
  })

  /**
   * The gate exists to hand an operator the exact command to type. It was
   * handing back `devloop answer retry`, and nothing puts `devloop` on `PATH`:
   * npm and pnpm do not link a package's own `bin` into its own
   * `node_modules/.bin`, and `dsh plugin add` does not either. So the one line
   * that was the point of the feature was the one line that could not be run.
   *
   * Asserting the wording would not have caught that, and did not. This takes
   * the printed line and feeds it back to the CLI: whatever it prints has to be
   * something this CLI accepts.
   */
  it('prints commands that this CLI actually accepts', async () => {
    const root = await armed({ ...emptyState(NOW), ...held('empty_task', { lastReviewVerdict: 'PASS' }) })
    const status = await runCli(['status', root], { invokedAs: 'node /some/where/devloop.js' })

    const printed = status.out.split('\n').filter(line => line.includes(' answer '))
    expect(printed).toHaveLength(3)

    for (const line of printed) {
      const words = line.trim().split(/\s+/)
      // Strip the invocation the operator would type, keep the arguments.
      expect(words.slice(0, 2)).toEqual(['node', '/some/where/devloop.js'])
      const [answer, key, target] = words.slice(2)
      expect(answer, line).toBe('answer')
      expect(target, line).toBe(root)

      const replayed = await runCli([answer, key!, target!])
      // Not "it worked" — it must not have been rejected as bad usage. Exit 2 is
      // this CLI's code for "that is not a command I take".
      expect(replayed.code, `${line} -> ${replayed.err}`).not.toBe(2)
      expect(replayed.err, line).not.toContain('is not an answer')
      expect(replayed.err, line).not.toContain('unknown option')
      expect(replayed.err, line).not.toContain('expected at most one')
    }
  })

  // Without an override it must still name a file that exists, not `devloop`
  // and not whatever happened to start the process — under this runner that
  // would be a vitest worker.
  it('names its own bin by default, not the process that started it', async () => {
    const root = await armed({ ...emptyState(NOW), ...held('empty_task') })
    const status = await runCli(['status', root])
    const line = status.out.split('\n').find(l => l.includes(' answer retry'))
    const binPath = line?.trim().split(/\s+/)[1]
    expect(binPath, line).toBeDefined()
    expect(binPath, line).toMatch(/bin[/\\]devloop\.(ts|js)$/)
    expect(existsSync(binPath!), `${String(binPath)} must exist`).toBe(true)
  })

  it('applies the answer and records it in the journal', async () => {
    const root = await armed({ ...emptyState(NOW), ...held('empty_task', { lastReviewVerdict: 'PASS' }) })
    const answered = await runCli(['answer', 'accept', root])
    expect(answered.out).toContain('answered accept for empty_task')
    const after = await runCli(['status', root])
    expect(after.out).not.toContain('supervisor hold')
  })

  it('rejects an answer the question did not offer, without touching state', async () => {
    const root = await armed({ ...emptyState(NOW), ...held('security_high_risk', { risk: 'high' }) })
    const before = await runCli(['status', root])
    const rejected = await runCli(['answer', 'retry', root])
    expect(rejected.code).toBe(1)
    expect(rejected.err).toContain('not an answer to this question')
    expect((await runCli(['status', root])).out).toBe(before.out)
  })

  it('rejects a word that is not an answer at all', async () => {
    const root = await armed({ ...emptyState(NOW), ...held('empty_task') })
    const result = await runCli(['answer', 'yolo', root])
    expect(result.code).toBe(2)
    expect(result.err).toContain('is not an answer')
  })

  it('says so when nothing is being asked', async () => {
    const root = await armed({
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'A', status: 'ready' })],
    })
    const result = await runCli(['answer', 'retry', root])
    expect(result.code).toBe(1)
    expect(result.err).toContain('not waiting on anything')
  })

  it('leaves the loop halted for stop, and says that is what happened', async () => {
    const root = await armed({ ...emptyState(NOW), ...held('empty_task') })
    const result = await runCli(['answer', 'stop', root])
    expect(result.code).toBe(0)
    expect(result.out).toContain('left halted: empty_task')
    expect((await runCli(['status', root])).out).toContain('supervisor hold: empty_task')
  })

  // The control matters as much as the case: assert only that `stop` appends
  // and a fix that writes an event for every branch would pass, breaking the
  // journal's one-event-per-revision rule that crash recovery reads.
  it('records a decision to leave a halt alone, so it is not mistaken for an unread one', async () => {
    const root = await armed({ ...emptyState(NOW), ...held('empty_task', { lastReviewVerdict: 'PASS' }) })
    const before = await journalLines(root)

    expect((await runCli(['answer', 'stop', root])).code).toBe(0)
    const afterStop = await journalLines(root)
    expect(afterStop.length).toBe(before.length + 1)
    expect(afterStop.at(-1)?.action).toBe('answer:stop')
    // The hold is untouched — it is the decision that was recorded, not a change.
    expect(afterStop.at(-1)?.state.supervisor).toMatchObject({ reason: 'empty_task' })
    expect(afterStop.at(-1)?.state.acknowledged).toMatchObject({ reason: 'empty_task', taskId: 'A' })

    // Control: an answer that does change things still advances by exactly one.
    expect((await runCli(['answer', 'accept', root])).out).toContain('answered accept')
    const afterAccept = await journalLines(root)
    expect(afterAccept.length).toBe(afterStop.length + 1)
    expect(afterAccept.map(event => event.revision)).toEqual(
      afterAccept.map((_, index) => index + 1),
    )
    // Lifting the hold clears the acknowledgement; it described that hold only.
    expect(afterAccept.at(-1)?.state.acknowledged).toBeUndefined()
  })

  it('still shows the recovery instructions for the one halt no answer can lift', async () => {
    const root = await armed({
      ...emptyState(NOW),
      killSwitch: true,
      supervisor: { taskId: null, reason: 'invalid_state' },
    })
    const result = await runCli(['status', root])
    expect(result.code).toBe(1)
    expect(result.out).toContain('STATE.json cannot be trusted')
    // Before, render() returned here and the composed guidance never printed.
    expect(result.out).toContain('The recorded state could not be read back')
    expect(result.out).toContain('EVENTS.jsonl')
  })
})

/**
 * The two tests above run against `src/`, so they say nothing about the layout
 * an operator actually runs. `selfInvocation` computes a path relative to this
 * module, and the built tree puts that module somewhere else — `lib/command.js`
 * next to `lib/bin/devloop.js`. Nothing asserted the answer is right there.
 *
 * This one spends a subprocess to buy a different claim than the replay test:
 * not that the printed command is accepted, but that running it — as a person
 * would, against the published artifact — moves the state.
 */
describe('the built CLI prints a command that does something', () => {
  const repo = join(import.meta.dirname, '..')
  const bin = join(repo, 'lib', 'bin', 'devloop.js')
  const scratch: string[] = []

  beforeAll(async () => {
    // `pnpm test` does not build, and Deploy.md runs test before build, so a
    // fresh clone would otherwise fail here for the wrong reason. ~1.5s.
    if (!existsSync(bin)) await promisify(execFile)('pnpm', ['build'], { cwd: repo })
  }, 60_000)

  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('runs its own printed answer against a real workspace', async () => {
    const root = await mkdtempInRepo('devloop-built-')
    scratch.push(root)
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await saveState(root, { ...emptyState(NOW), ...held('empty_task', { lastReviewVerdict: 'PASS' }) })
    const before = (await loadState(root, Date.now())).revision

    const status = await run([bin, 'status', root])
    expect(status.code, status.err).toBe(1)

    const line = status.out.split('\n').find(l => l.includes(' answer accept '))
    expect(line, status.out).toBeDefined()
    const words = line!.trim().split(/\s+/)
    // Everything up to and including the workspace is the command; the rest of
    // the line is the summary a person reads.
    const argv = words.slice(0, words.indexOf(root) + 1)
    expect(argv[0]).toBe('node')
    expect(argv[1]).toBe(bin)

    const answered = await run(argv.slice(1))
    // Not the exit code beyond "this was a command at all": what it exits with
    // after accepting is a claim about halt semantics, which is not what this
    // test is named for and would send the next reader looking at the printed
    // command when it was the semantics that changed.
    expect(answered.code, answered.err).not.toBe(2)
    expect(answered.out).toContain('answered accept')
    // The claim this test exists for: the command moved the state.
    expect((await loadState(root, Date.now())).revision).toBeGreaterThan(before)
  }, 60_000)

  async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', argv)
      return { code: 0, out: stdout, err: stderr }
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string }
      return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }
    }
  }
})

async function journalLines(root: string): Promise<{ revision: number; action: string; state: LoopState }[]> {
  const text = await readFile(join(root, '.devloop', 'EVENTS.jsonl'), 'utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as { revision: number; action: string; state: LoopState })
}

describe('gates that ask for a redo from the base', () => {
  // Nothing reads PLAN.md back, and a plain resume reuses the task's worktree
  // and base, so either instruction alone would change nothing.
  it.each([['task_over_budget:340 lines, 7 files'], ['review_requested_replan']])('%s tells the operator a redo that actually starts over', (reason) => {
    const gate = gateFor(held(reason), limits, NOW)
    expect(gate?.options.map(o => o.key)).toEqual(['stop'])
    expect(gate?.manual).toContain('git worktree remove --force .devloop/worktrees/A && git branch -D devloop/A')
    expect(gate?.manual).toContain('devloop resume --task A')
    expect(gate?.manual).not.toContain('PLAN.md')
  })
})
