import { describe, expect, it } from 'vitest'
import { emptyUsage, evaluateBudget, recordAction } from '../src/budget.ts'
import { ConfigSchema, resolveConfig } from '../src/config.ts'
import type { LoopState } from '../src/types.ts'

const limits = resolveConfig({}).budget

function base(overrides: Partial<LoopState> = {}): LoopState {
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

describe('evaluateBudget', () => {
  it('fills taskLifetimeMinutes from per-attempt timeout times max attempts', () => {
    const budget = resolveConfig({ budget: { taskTimeoutMinutes: 1, maxTaskAttempts: 3 } }).budget
    expect(budget.taskTimeoutMinutes).toBe(1)
    expect(budget.taskLifetimeMinutes).toBeGreaterThanOrEqual(3)
  })

  it('raises lifetime after ConfigSchema has already filled the 135 default', () => {
    const viaSchema = resolveConfig(ConfigSchema({ budget: { taskTimeoutMinutes: 90 } }))
    expect(viaSchema.budget.taskTimeoutMinutes).toBe(90)
    expect(viaSchema.budget.taskLifetimeMinutes).toBeGreaterThanOrEqual(270)
  })

  it('trips the daily cost cap', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), costUsdDay: 20 } }),
      limits,
      0,
      { type: 'plan' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'daily_cost_cap', taskId: null })
  })

  it('trips max attempts on delegate', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), taskAttempts: { 't-1': 3 } } }),
      limits,
      0,
      { type: 'delegate', taskId: 't-1' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'max_task_attempts:t-1', taskId: 't-1' })
  })

  it('does not trip lifetime after one full per-attempt window', () => {
    const verdict = evaluateBudget(
      base({
        tasks: [{
          id: 't-1',
          title: 't-1',
          tier: 'T1',
          status: 'running',
          risk: 'low',
          attempts: 0,
          reviewCycles: 0,
          allowedPaths: ['src/**'],
          acceptance: ['tests pass'],
        }],
        usage: {
          ...emptyUsage(0),
          taskStartedAt: { 't-1': 0 },
          lastProgressAt: 44 * 60_000,
        },
      }),
      limits,
      limits.taskTimeoutMinutes * 60_000,
      { type: 'idle' },
    )
    expect(verdict).toEqual({ ok: true })
  })

  it('does not trip lifetime at half of one per-attempt window', () => {
    const verdict = evaluateBudget(
      base({
        tasks: [{
          id: 't-1',
          title: 't-1',
          tier: 'T1',
          status: 'ready',
          risk: 'low',
          attempts: 0,
          reviewCycles: 0,
          allowedPaths: ['src/**'],
          acceptance: ['tests pass'],
        }],
        usage: { ...emptyUsage(0), taskStartedAt: { 't-1': 0 } },
      }),
      limits,
      limits.taskTimeoutMinutes * 30_000,
      { type: 'delegate', taskId: 't-1' },
    )
    expect(verdict).toEqual({ ok: true })
  })

  it('trips task lifetime timeout on idle while a task is running', () => {
    const life = limits.taskLifetimeMinutes * 60_000
    const verdict = evaluateBudget(
      base({
        tasks: [{
          id: 't-1',
          title: 't-1',
          tier: 'T1',
          status: 'running',
          risk: 'low',
          attempts: 0,
          reviewCycles: 0,
          allowedPaths: ['src/**'],
          acceptance: ['tests pass'],
        }],
        usage: {
          ...emptyUsage(0),
          taskStartedAt: { 't-1': 0 },
          lastProgressAt: life - 60_000,
        },
      }),
      limits,
      life,
      { type: 'idle' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'task_timeout:t-1', taskId: 't-1' })
  })

  it('trips task lifetime timeout on delegate', () => {
    const life = limits.taskLifetimeMinutes * 60_000
    const verdict = evaluateBudget(
      base({
        tasks: [{
          id: 't-1',
          title: 't-1',
          tier: 'T1',
          status: 'ready',
          risk: 'low',
          attempts: 0,
          reviewCycles: 0,
          allowedPaths: ['src/**'],
          acceptance: ['tests pass'],
        }],
        usage: { ...emptyUsage(0), taskStartedAt: { 't-1': 0 } },
      }),
      limits,
      life,
      { type: 'delegate', taskId: 't-1' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'task_timeout:t-1', taskId: 't-1' })
  })

  it('ignores leftover start times for tasks that left the queue', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), taskStartedAt: { gone: 0 } } }),
      limits,
      45 * 60_000,
      { type: 'plan' },
    )
    expect(verdict).toEqual({ ok: true })
  })

  it('trips duplicate action', () => {
    const verdict = evaluateBudget(
      base({
        usage: {
          ...emptyUsage(0),
          lastActions: ['delegate:t-1', 'delegate:t-1', 'delegate:t-1'],
        },
      }),
      limits,
      0,
      { type: 'delegate', taskId: 't-1' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'duplicate_action:delegate:t-1', taskId: 't-1' })
  })

  it('trips no-progress watchdog on idle', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), lastProgressAt: 0 } }),
      limits,
      15 * 60_000,
      { type: 'idle' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'no_progress', taskId: null })
  })

  it('allows a fresh delegate under the caps', () => {
    const verdict = evaluateBudget(base(), limits, 1000, { type: 'delegate', taskId: 't-1' })
    expect(verdict).toEqual({ ok: true })
  })

  it('trips the token cap on delegate', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), tokens: { 't-1': 500_000 } } }),
      limits,
      0,
      { type: 'delegate', taskId: 't-1' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'max_tokens_per_task', taskId: 't-1' })
  })

  it('trips the token cap on idle while a task is running', () => {
    const verdict = evaluateBudget(
      base({
        tasks: [{
          id: 't-1',
          title: 't-1',
          tier: 'T1',
          status: 'running',
          risk: 'low',
          attempts: 0,
          reviewCycles: 0,
          allowedPaths: ['src/**'],
          acceptance: ['tests pass'],
        }],
        usage: { ...emptyUsage(0), tokens: { 't-1': 500_000 } },
      }),
      limits,
      0,
      { type: 'idle' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'max_tokens_per_task', taskId: 't-1' })
  })

  it('trips review cap on a rework delegate', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), reviewCycles: { 't-1': 2 } } }),
      limits,
      0,
      { type: 'delegate', taskId: 't-1' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'max_review_cycles:t-1', taskId: 't-1' })
  })

  it('does not apply another task token cap to a fresh task', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), tokens: { 't-1': 500_000 } } }),
      limits,
      0,
      { type: 'delegate', taskId: 't-2' },
    )
    expect(verdict).toEqual({ ok: true })
  })

  it('records and caps attempts for prototype-reserved task ids', () => {
    let usage = emptyUsage(0)
    for (let index = 0; index < 3; index += 1) {
      usage = recordAction(usage, { type: 'delegate', taskId: '__proto__' }, index)
    }
    expect(usage.taskAttempts['__proto__']).toBe(3)
    expect(Object.hasOwn(usage.taskAttempts, '__proto__')).toBe(true)
    expect(evaluateBudget(
      base({ usage }),
      limits,
      0,
      { type: 'delegate', taskId: '__proto__' },
    )).toEqual({ ok: false, reason: 'max_task_attempts:__proto__', taskId: '__proto__' })
  })

  it('trips timeout for an empty task id', () => {
    const verdict = evaluateBudget(
      base({
        tasks: [{
          id: '',
          title: 'empty',
          tier: 'T1',
          status: 'running',
          risk: 'low',
          attempts: 0,
          reviewCycles: 0,
          allowedPaths: ['src/**'],
          acceptance: ['tests pass'],
        }],
        usage: {
          ...emptyUsage(0),
          taskStartedAt: { '': 0 },
          lastProgressAt: limits.taskLifetimeMinutes * 60_000 - 60_000,
        },
      }),
      limits,
      limits.taskLifetimeMinutes * 60_000,
      { type: 'idle' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'task_timeout:', taskId: '' })
  })
})
