import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/command.ts'
import { resolveConfig } from '../src/config.ts'
import { applyAnswer, gateFor } from '../src/gate.ts'
import { emptyState, saveState } from '../src/persist.ts'
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

  it('leaves everything alone for stop, which is a decision', () => {
    const state = held('empty_task')
    expect(applyAnswer(state, gate('empty_task'), 'stop', NOW)).toBe(state)
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
    const state = held('empty_task', { lastReviewVerdict: 'PASS' })
    expect(applyAnswer(state, gate('empty_task'), 'accept', NOW).tasks[0]?.status).toBe('done')
    // accept is offered nowhere else, so no other halt can reach that status.
    for (const reason of ['no_review_pass', 'scope_violation', 'blocked_task', 'max_task_attempts:A']) {
      expect(gate(reason).options.map(o => o.key), reason).not.toContain('accept')
    }
  })

  it('refuses an answer that needs a task when the halt names none', () => {
    const corrupt: LoopState = { ...baseState(), killSwitch: true, supervisor: { taskId: null, reason: 'invalid_state' } }
    const g = gateFor(corrupt, limits, NOW)!
    expect(() => applyAnswer(corrupt, { ...g, options: [{ key: 'retry', summary: 'x' }] }, 'retry', NOW))
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
    const result = await runCli(['status', root])
    expect(result.code).toBe(1)
    expect(result.out).toContain('Did it need any change?')
    expect(result.out).toContain('devloop answer retry')
    expect(result.out).toContain('devloop answer accept')
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
})
