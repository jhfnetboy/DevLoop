import type { BudgetLimits } from './config.js'
import { evaluateBudget, recordAction } from './budget.js'
import { actionKey, decideNextAction } from './loop.js'
import type { LoopAction, LoopState } from './types.js'

export interface TickResult {
  readonly action: LoopAction
  readonly state: LoopState
  readonly skipped: boolean
}

/**
 * One deterministic beat: decide, apply budget, persist-ready next state.
 * 0.1 records the action only; it does not spawn workers.
 *
 * Repeating the same work action is latched (no rewrite) until budget
 * treats the wait as idle and may halt for no-progress.
 */
export function runTick(state: LoopState, limits: BudgetLimits, now: number): TickResult {
  if (state.killSwitch || state.lastAction.type === 'stop') {
    const action: LoopAction = state.lastAction.type === 'stop'
      ? state.lastAction
      : { type: 'stop', reason: 'kill_switch' }
    return { action, state, skipped: true }
  }

  let intended = decideNextAction(state)
  const latched = isWorkAction(intended)
    && actionKey(intended) === actionKey(state.lastAction)
    && dispatchStatus(state, intended) === state.lastDispatchStatus
  if (latched) {
    intended = { type: 'idle' }
  }

  if (intended.type === 'stop' && intended.reason === 'goal_complete') {
    return persistAction(state, intended, now)
  }

  const circuit = evaluateBudget(state, limits, now, intended)
  const action: LoopAction = circuit.ok
    ? intended
    : { type: 'stop', reason: 'budget' }

  if (circuit.ok && (action.type === 'idle' || latched)) {
    return { action: state.lastAction, state, skipped: true }
  }

  return persistAction(state, action, now, circuit.ok ? undefined : circuit)
}

function persistAction(
  state: LoopState,
  action: LoopAction,
  now: number,
  circuit?: { ok: false; reason: string; taskId: string | null },
): TickResult {
  const usage = recordAction(state.usage, action, now)
  const next: LoopState = {
    ...state,
    usage,
    lastAction: action,
    lastDispatchStatus: isWorkAction(action) ? dispatchStatus(state, action) : state.lastDispatchStatus,
    updatedAt: new Date(now).toISOString(),
    killSwitch: action.type === 'stop',
    supervisor: circuit ? { taskId: circuit.taskId, reason: circuit.reason } : state.supervisor,
  }
  return { action, state: next, skipped: false }
}

function isWorkAction(action: LoopAction): boolean {
  return action.type !== 'idle' && action.type !== 'stop'
}

function dispatchStatus(state: LoopState, action: LoopAction): string | null {
  if (action.type === 'delegate' || action.type === 'review' || action.type === 'merge') {
    return state.tasks.find(task => task.id === action.taskId)?.status ?? null
  }
  if (action.type === 'escalate') {
    return action.reason
  }
  return null
}
