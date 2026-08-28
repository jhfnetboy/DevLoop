import { describe, expect, it } from 'vitest'
import { emptyUsage } from '../src/budget.ts'
import { decideNextAction } from '../src/loop.ts'
import type { LoopState, Task } from '../src/types.ts'

function task(partial: Partial<Task> & Pick<Task, 'id' | 'status'>): Task {
  return {
    title: partial.id,
    tier: 'T1',
    risk: 'low',
    attempts: 0,
    reviewCycles: 0,
    allowedPaths: ['src/**'],
    acceptance: ['tests pass'],
    ...partial,
  }
}

function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    version: 1,
    goalCompleted: false,
    killSwitch: false,
    supervisor: null,
    tasks: [],
    usage: emptyUsage(0),
    lastAction: { type: 'idle' },
    lastDispatchStatus: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('decideNextAction', () => {
  it('stops on kill switch before anything else', () => {
    expect(decideNextAction(state({
      killSwitch: true,
      tasks: [task({ id: 'a', status: 'ready' })],
    }))).toEqual({ type: 'stop', reason: 'kill_switch' })
  })

  it('stops when the goal is complete', () => {
    expect(decideNextAction(state({ goalCompleted: true }))).toEqual({
      type: 'stop',
      reason: 'goal_complete',
    })
  })

  it('escalates when supervisor hold is set', () => {
    expect(decideNextAction(state({
      supervisor: { taskId: 'a', reason: 'security_high_risk' },
      tasks: [task({ id: 'a', status: 'ready' })],
    }))).toEqual({
      type: 'escalate',
      taskId: 'a',
      reason: 'security_high_risk',
    })
  })

  it('reviews before delegating', () => {
    expect(decideNextAction(state({
      tasks: [
        task({ id: 'ready-1', status: 'ready' }),
        task({ id: 'rev-1', status: 'review_pending' }),
      ],
    }))).toEqual({ type: 'review', taskId: 'rev-1' })
  })

  it('merges before delegating', () => {
    expect(decideNextAction(state({
      tasks: [
        task({ id: 'ready-1', status: 'ready' }),
        task({ id: 'm-1', status: 'merge_ready', lastReviewVerdict: 'PASS' }),
      ],
    }))).toEqual({ type: 'merge', taskId: 'm-1' })
  })

  it('delegates a ready task', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 't-1', status: 'ready' })],
    }))).toEqual({ type: 'delegate', taskId: 't-1' })
  })

  it('delegates rework after ready is exhausted', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 't-2', status: 'rework' })],
    }))).toEqual({ type: 'delegate', taskId: 't-2' })
  })

  it('plans when there are no tasks', () => {
    expect(decideNextAction(state())).toEqual({ type: 'plan' })
  })

  it('idles while a worker is running and nothing else is queued', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 't-1', status: 'running' })],
    }))).toEqual({ type: 'idle' })
  })

  it('treats all-done tasks as goal complete', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 't-1', status: 'done' })],
    }))).toEqual({ type: 'stop', reason: 'goal_complete' })
  })

  it('escalates a failed queue instead of idling', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 't-9', status: 'failed' })],
    }))).toEqual({
      type: 'escalate',
      taskId: 't-9',
      reason: 'repeated_test_failure',
    })
  })

  it('idles when a failed task is waiting on in-flight work', () => {
    expect(decideNextAction(state({
      tasks: [
        task({ id: 'fail-1', status: 'failed' }),
        task({ id: 'run-1', status: 'running' }),
        task({ id: 'ready-1', status: 'ready' }),
      ],
    }))).toEqual({ type: 'idle' })
  })

  it('escalates blocked tasks before review or delegate', () => {
    expect(decideNextAction(state({
      tasks: [
        task({ id: 'ready-1', status: 'ready' }),
        task({ id: 'block-1', status: 'blocked' }),
      ],
    }))).toEqual({
      type: 'escalate',
      taskId: 'block-1',
      reason: 'blocked_task',
    })
  })

  it('escalates failed tasks before review or delegate', () => {
    expect(decideNextAction(state({
      tasks: [
        task({ id: 'ready-1', status: 'ready' }),
        task({ id: 'rev-1', status: 'review_pending' }),
        task({ id: 'fail-1', status: 'failed' }),
      ],
    }))).toEqual({
      type: 'escalate',
      taskId: 'fail-1',
      reason: 'repeated_test_failure',
    })
  })

  it('escalates high-risk review_pending before review', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 't-h', status: 'review_pending', risk: 'high' })],
    }))).toEqual({
      type: 'escalate',
      taskId: 't-h',
      reason: 'security_high_risk',
    })
  })

  it('escalates merge_ready without Review PASS', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 'm-1', status: 'merge_ready' })],
    }))).toEqual({
      type: 'escalate',
      taskId: 'm-1',
      reason: 'no_review_pass',
    })
  })

  it('escalates merge_ready with REWORK', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 'm-1', status: 'merge_ready', lastReviewVerdict: 'REWORK' })],
    }))).toEqual({
      type: 'escalate',
      taskId: 'm-1',
      reason: 'no_review_pass',
    })
  })

  it('merges PASS_WITH_NOTES', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 'm-1', status: 'merge_ready', lastReviewVerdict: 'PASS_WITH_NOTES' })],
    }))).toEqual({ type: 'merge', taskId: 'm-1' })
  })

  it('escalates high-risk merge_ready before merge', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 't-h', status: 'merge_ready', risk: 'high', lastReviewVerdict: 'PASS' })],
    }))).toEqual({
      type: 'escalate',
      taskId: 't-h',
      reason: 'security_high_risk',
    })
  })

  it('escalates high-risk ready work before delegate', () => {
    expect(decideNextAction(state({
      tasks: [task({ id: 't-h', status: 'ready', risk: 'high' })],
    }))).toEqual({
      type: 'escalate',
      taskId: 't-h',
      reason: 'security_high_risk',
    })
  })
})
