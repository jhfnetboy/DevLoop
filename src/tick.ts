import type { BudgetLimits } from './config.js'
import { evaluateBudget, recordAction } from './budget.js'
import { decideNextAction } from './loop.js'
import type { LoopAction, LoopState } from './types.js'

export interface TickResult {
  readonly action: LoopAction
  readonly state: LoopState
  readonly skipped: boolean
}

/**
 * One deterministic beat: decide, apply budget, persist-ready next state.
 * 0.1 records the action only; it does not spawn workers.
 */
export function runTick(state: LoopState, limits: BudgetLimits, now: number): TickResult {
  const intended = decideNextAction(state)
  const circuit = evaluateBudget(state, limits, now, intended)
  const action: LoopAction = circuit.ok
    ? intended
    : { type: 'stop', reason: 'budget' }

  const usage = recordAction(state.usage, action, now)
  const next: LoopState = {
    ...state,
    usage,
    lastAction: action,
    updatedAt: new Date(now).toISOString(),
    supervisor: circuit.ok
      ? state.supervisor
      : { taskId: 'taskId' in intended ? intended.taskId : null, reason: circuit.reason },
  }

  return { action, state: next, skipped: false }
}
