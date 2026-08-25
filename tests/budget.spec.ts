import { describe, expect, it } from 'vitest'
import { emptyUsage, evaluateBudget } from '../src/budget.ts'
import { resolveConfig } from '../src/config.ts'
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
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('evaluateBudget', () => {
  it('trips the daily cost cap', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), costUsdDay: 20 } }),
      limits,
      0,
      { type: 'plan' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'daily_cost_cap' })
  })

  it('trips max attempts on delegate', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), taskAttempts: { 't-1': 3 } } }),
      limits,
      0,
      { type: 'delegate', taskId: 't-1' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'max_task_attempts:t-1' })
  })

  it('trips task wall-clock timeout', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), taskStartedAt: { 't-1': 0 } } }),
      limits,
      45 * 60_000,
      { type: 'delegate', taskId: 't-1' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'task_timeout:t-1' })
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
    expect(verdict).toEqual({ ok: false, reason: 'duplicate_action:delegate:t-1' })
  })

  it('trips no-progress watchdog on idle', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), lastProgressAt: 0 } }),
      limits,
      15 * 60_000,
      { type: 'idle' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'no_progress' })
  })

  it('allows a fresh delegate under the caps', () => {
    const verdict = evaluateBudget(base(), limits, 1000, { type: 'delegate', taskId: 't-1' })
    expect(verdict).toEqual({ ok: true })
  })

  it('trips the token cap on delegate', () => {
    const verdict = evaluateBudget(
      base({ usage: { ...emptyUsage(0), tokens: 500_000 } }),
      limits,
      0,
      { type: 'delegate', taskId: 't-1' },
    )
    expect(verdict).toEqual({ ok: false, reason: 'max_tokens_per_task' })
  })
})
