import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { applyOutcome, readOutcome, MAX_PLANNED_TASKS } from '../src/outcome.ts'
import { decideNextAction } from '../src/loop.ts'
import { runTick } from '../src/tick.ts'
import type { AgentOutcome } from '../src/outcome.ts'
import { baseState, makeTask, withTasks } from './helpers.ts'

const limits = resolveConfig({}).budget

describe('applyOutcome', () => {
  it('appends planned tasks as ready', () => {
    const next = applyOutcome(
      baseState(),
      { type: 'plan' },
      { kind: 'plan', tasks: [{ id: 'AUTH-001', title: 'schema', tier: 'T2', risk: 'medium' }] },
      limits,
    )
    expect(next.tasks).toHaveLength(1)
    expect(next.tasks[0]).toMatchObject({ id: 'AUTH-001', status: 'ready', tier: 'T2', risk: 'medium' })
  })

  it('rejects planned ids that are unsafe as git branch names', () => {
    const next = applyOutcome(
      baseState(),
      { type: 'plan' },
      { kind: 'plan', tasks: [{ id: '../escape', title: 'bad' }, { id: 'a b', title: 'bad' }] },
      limits,
    )
    expect(next.tasks).toHaveLength(0)
  })

  it('drops duplicate ids and caps how far a planner can grow STATE', () => {
    const seeded = withTasks(baseState(), [makeTask({ id: 'A', status: 'ready' })])
    const many = Array.from({ length: MAX_PLANNED_TASKS + 10 }, (_, i) => ({ id: `T${i}`, title: 't' }))
    const next = applyOutcome(seeded, { type: 'plan' }, { kind: 'plan', tasks: [{ id: 'A', title: 'dup' }, ...many] }, limits)
    expect(next.tasks).toHaveLength(MAX_PLANNED_TASKS)
    expect(next.tasks.filter(task => task.id === 'A')).toHaveLength(1)
  })

  it('moves a delegated task to review_pending and burns an attempt', () => {
    const state = withTasks(baseState(), [makeTask({ id: 'A', status: 'ready' })])
    const next = applyOutcome(state, { type: 'delegate', taskId: 'A' }, { kind: 'implement', ok: true }, limits)
    expect(next.tasks[0]).toMatchObject({ status: 'review_pending', attempts: 1 })
  })

  it('sends a failed implementation to rework, then failed at the attempt cap', () => {
    let state = withTasks(baseState(), [makeTask({ id: 'A', status: 'ready' })])
    const fail: AgentOutcome = { kind: 'implement', ok: false }
    for (let i = 0; i < limits.maxTaskAttempts - 1; i += 1) {
      state = applyOutcome(state, { type: 'delegate', taskId: 'A' }, fail, limits)
      expect(state.tasks[0]?.status).toBe('rework')
    }
    state = applyOutcome(state, { type: 'delegate', taskId: 'A' }, fail, limits)
    expect(state.tasks[0]).toMatchObject({ status: 'failed', attempts: limits.maxTaskAttempts })
  })

  it('clears a stale PASS when the task is implemented again', () => {
    const state = withTasks(baseState(), [
      makeTask({ id: 'A', status: 'rework', lastReviewVerdict: 'PASS' }),
    ])
    const next = applyOutcome(state, { type: 'delegate', taskId: 'A' }, { kind: 'implement', ok: true }, limits)
    expect(next.tasks[0]?.lastReviewVerdict).toBeUndefined()
    expect(decideNextAction(next)).toEqual({ type: 'review', taskId: 'A' })
  })

  it('turns a PASS into merge_ready and a REWORK into rework', () => {
    const state = withTasks(baseState(), [makeTask({ id: 'A', status: 'review_pending' })])
    const passed = applyOutcome(state, { type: 'review', taskId: 'A' }, { kind: 'review', verdict: 'PASS' }, limits)
    expect(passed.tasks[0]).toMatchObject({ status: 'merge_ready', lastReviewVerdict: 'PASS', reviewCycles: 1 })
    expect(decideNextAction(passed)).toEqual({ type: 'merge', taskId: 'A' })

    const reworked = applyOutcome(state, { type: 'review', taskId: 'A' }, { kind: 'review', verdict: 'REWORK' }, limits)
    expect(reworked.tasks[0]).toMatchObject({ status: 'rework', lastReviewVerdict: 'REWORK' })
  })

  it('blocks a task that keeps failing review instead of looping forever', () => {
    let state = withTasks(baseState(), [
      makeTask({ id: 'A', status: 'review_pending', reviewCycles: limits.maxReviewCycles - 1 }),
    ])
    state = applyOutcome(state, { type: 'review', taskId: 'A' }, { kind: 'review', verdict: 'REWORK' }, limits)
    expect(state.tasks[0]?.status).toBe('blocked')
  })

  it('holds for the supervisor on REPLAN', () => {
    const state = withTasks(baseState(), [makeTask({ id: 'A', status: 'review_pending' })])
    const next = applyOutcome(state, { type: 'review', taskId: 'A' }, { kind: 'review', verdict: 'REPLAN' }, limits)
    expect(next.supervisor).toEqual({ taskId: 'A', reason: 'replan_requested' })
    expect(next.tasks[0]?.status).toBe('blocked')
  })

  it('never merges on a verdict the reviewer did not give', () => {
    const state = withTasks(baseState(), [makeTask({ id: 'A', status: 'review_pending' })])
    for (const verdict of ['REWORK', 'REPLAN', 'BLOCKED'] as const) {
      const next = applyOutcome(state, { type: 'review', taskId: 'A' }, { kind: 'review', verdict }, limits)
      expect(decideNextAction(next).type).not.toBe('merge')
    }
  })

  it('ignores an outcome that does not match the dispatched action or task', () => {
    const state = withTasks(baseState(), [makeTask({ id: 'A', status: 'ready' })])
    expect(applyOutcome(state, { type: 'delegate', taskId: 'A' }, { kind: 'review', verdict: 'PASS' }, limits)).toBe(state)
    expect(applyOutcome(state, { type: 'delegate', taskId: 'ghost' }, { kind: 'implement', ok: true }, limits)).toBe(state)
    expect(applyOutcome(state, { type: 'plan' }, { kind: 'plan', tasks: [] }, limits)).toBe(state)
  })
})

describe('readOutcome', () => {
  it('reads the last fenced json block out of chatty output', () => {
    const text = [
      'Thinking about it...',
      '```json\n{"kind":"review","verdict":"REWORK"}\n```',
      'On reflection:',
      '```json\n{"kind":"review","verdict":"PASS","notes":"ok"}\n```',
    ].join('\n')
    expect(readOutcome(text, 'review')).toEqual({ kind: 'review', verdict: 'PASS', notes: 'ok' })
  })

  it('reads a bare json object with prose around it', () => {
    expect(readOutcome('done!\n{"ok": true}\nbye', 'delegate')).toEqual({ kind: 'implement', ok: true })
  })

  it('refuses output that carries no usable envelope', () => {
    expect(readOutcome('I finished the task, looks good.', 'review')).toBeUndefined()
    expect(readOutcome('{"verdict":"LGTM"}', 'review')).toBeUndefined()
    expect(readOutcome('', 'plan')).toBeUndefined()
  })

  it('refuses an envelope for a different action than the one dispatched', () => {
    expect(readOutcome('{"kind":"review","verdict":"PASS"}', 'delegate')).toBeUndefined()
  })

  it('keeps only well-formed planned tasks', () => {
    const parsed = readOutcome('{"kind":"plan","tasks":[{"id":"A","title":"t"},{"id":5}]}', 'plan')
    expect(parsed).toEqual({ kind: 'plan', tasks: [{ id: 'A', title: 't' }] })
  })
})

describe('the loop no longer wedges once outcomes flow back', () => {
  it('walks plan → delegate → review → merge without a human touching STATE', () => {
    let state = baseState()

    let beat = runTick(state, limits, 1_000)
    expect(beat.action).toEqual({ type: 'plan' })
    state = applyOutcome(beat.state, { type: 'plan' }, {
      kind: 'plan',
      tasks: [{ id: 'AUTH-001', title: 'schema' }],
    }, limits)

    beat = runTick(state, limits, 2_000)
    expect(beat.action).toEqual({ type: 'delegate', taskId: 'AUTH-001' })
    state = applyOutcome(beat.state, beat.action as never, { kind: 'implement', ok: true }, limits)

    beat = runTick(state, limits, 3_000)
    expect(beat.action).toEqual({ type: 'review', taskId: 'AUTH-001' })
    state = applyOutcome(beat.state, beat.action as never, { kind: 'review', verdict: 'PASS' }, limits)

    beat = runTick(state, limits, 4_000)
    expect(beat.action).toEqual({ type: 'merge', taskId: 'AUTH-001' })
  })

  it('without an outcome the same tick latches into idle — the bug this closes', () => {
    const state = withTasks(baseState(), [makeTask({ id: 'A', status: 'ready' })])
    const first = runTick(state, limits, 1_000)
    expect(first.action).toEqual({ type: 'delegate', taskId: 'A' })
    const second = runTick(first.state, limits, 2_000)
    expect(second.skipped).toBe(true)
  })
})
