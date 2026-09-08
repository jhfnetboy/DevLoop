import type { BudgetLimits } from './config.js'
import { evaluateBudget, rollCostWindows } from './budget.js'
import { decideNextAction } from './loop.js'
import type { LoopAction, LoopState, Task } from './types.js'

export interface ResumeOptions {
  /** Give this task another attempt and clear the counters that stopped it. */
  readonly taskId?: string
  /** Also clear the daily spend window. Off by default: a cap is not a glitch. */
  readonly resetCost?: boolean
}

export interface HaltDiagnosis {
  readonly halted: boolean
  /** Why the loop is stopped now, most specific first. */
  readonly reasons: readonly string[]
  /** What would stop it again on the next tick, given these resume options. */
  readonly wouldHaltAgain: string | null
  /** A task worth naming with --task, when one would unblock the loop. */
  readonly taskId: string | null
  /** State this command must not touch: the file itself is suspect. */
  readonly integrityHold: string | null
}

/** Halts the host synthesises when STATE cannot be trusted; never resumable. */
const INTEGRITY_HOLDS = new Set(['unreadable_state', 'invalid_state', 'escaped_devloop'])

export function integrityHold(state: LoopState): string | null {
  const reason = state.supervisor?.reason
  return reason !== undefined && INTEGRITY_HOLDS.has(reason) ? reason : null
}

/**
 * Explain a halted loop, and — the part that matters — say whether resuming
 * with these options would achieve anything.
 *
 * Clearing `killSwitch` alone is usually a false recovery: whatever stopped the
 * loop is still there, so the next tick stops for the same reason. The check
 * runs `decideNextAction` on the state `resumeState` would actually write, so a
 * terminal action counts as blocked even when no budget circuit has tripped —
 * a goal already complete, a task that only ever escalates, a high-risk task
 * that is routed to a human by policy.
 */
export function diagnoseHalt(
  state: LoopState,
  limits: BudgetLimits,
  now: number,
  options: ResumeOptions = {},
): HaltDiagnosis {
  const reasons: string[] = []
  let taskId: string | null = null

  const integrity = integrityHold(state)
  if (integrity !== null) reasons.push(`state integrity hold: ${integrity}`)
  if (state.killSwitch) reasons.push('killSwitch is set')
  if (state.lastAction.type === 'stop') reasons.push(`last action was stop:${state.lastAction.reason}`)
  if (state.supervisor && integrity === null) {
    reasons.push(`supervisor hold: ${state.supervisor.reason}`)
    taskId = state.supervisor.taskId
  }
  if (state.goalCompleted) reasons.push('goal is marked complete')
  for (const task of state.tasks) {
    if (task.status === 'failed' || task.status === 'blocked') {
      reasons.push(`task ${task.id} is ${task.status}`)
      taskId = taskId ?? task.id
    }
  }

  if (integrity !== null) {
    return { halted: true, reasons, wouldHaltAgain: integrity, taskId, integrityHold: integrity }
  }

  let resumed: LoopState
  try {
    resumed = resumeState(state, options, now)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'resume is not possible'
    return { halted: true, reasons, wouldHaltAgain: reason, taskId, integrityHold: null }
  }

  return {
    halted: reasons.length > 0,
    reasons,
    wouldHaltAgain: blockedReason(resumed, limits, now),
    taskId,
    integrityHold: null,
  }
}

/**
 * What would stop the loop on its next tick, or null if it would do real work.
 * A `stop` or an `escalate` is as blocking as a tripped breaker; only the
 * breaker announces itself.
 */
function blockedReason(state: LoopState, limits: BudgetLimits, now: number): string | null {
  const intended: LoopAction = decideNextAction(state)
  if (intended.type === 'stop') return `stop:${intended.reason}`
  if (intended.type === 'escalate') return `escalate:${intended.reason}`
  // Idle is ordinary waiting, not a halt: work in flight looks exactly like this.
  const circuit = evaluateBudget(state, limits, now, intended)
  return circuit.ok ? null : circuit.reason
}

/**
 * Lift a halt so the loop can run again.
 *
 * Pure: the caller persists this under the state lock. Resetting the hold is
 * only half the job — the no-progress and duplicate-action circuits are keyed
 * on history that is now stale, so they are cleared too. Per-task counters are
 * cleared only for a task named explicitly, because forgetting that a task has
 * already burned three attempts is exactly how an unattended loop starts
 * spending without end.
 */
export function resumeState(state: LoopState, options: ResumeOptions, now: number): LoopState {
  const integrity = integrityHold(state)
  if (integrity !== null) {
    throw new Error(`resume: refusing to overwrite a ${integrity} hold; repair STATE.json first`)
  }

  // Roll the cost windows against the OLD timestamp: it is the day anchor, and
  // moving it first would stamp yesterday's spend as today's and keep the daily
  // cap tripped for good. The session window is cleared because restarting the
  // profile — which a resume requires — clears it anyway.
  const rolled = rollCostWindows(state.usage, now, true)

  let next: LoopState = {
    ...state,
    killSwitch: false,
    supervisor: null,
    lastAction: { type: 'idle' },
    lastDispatchStatus: null,
    usage: {
      ...rolled,
      // Both of these are judgements about history that no longer applies.
      lastActions: [],
      lastProgressAt: now,
    },
  }

  if (options.taskId !== undefined) {
    const target = state.tasks.find(task => task.id === options.taskId)
    if (!target) throw new Error(`resume: no task ${options.taskId}`)
    next = {
      ...next,
      // Reopening a task is the only thing that makes a finished goal unfinished.
      goalCompleted: false,
      tasks: next.tasks.map(task => task.id === target.id ? retry(task) : task),
      usage: {
        ...next.usage,
        taskAttempts: without(next.usage.taskAttempts, target.id),
        reviewCycles: without(next.usage.reviewCycles, target.id),
        tokens: without(next.usage.tokens, target.id),
        // Dropping the start time restarts the task's lifetime, which would
        // otherwise time it out again immediately.
        taskStartedAt: without(next.usage.taskStartedAt, target.id),
      },
    }
  }

  if (options.resetCost === true) {
    next = { ...next, usage: { ...next.usage, costUsdDay: 0 } }
  }

  return { ...next, updatedAt: new Date(now).toISOString() }
}

/** A retried task goes back to the worker, never forward to a merge. */
function retry(task: Task): Task {
  const { lastReviewVerdict: _verdict, reviewer: _reviewer, ...rest } = task
  return { ...rest, status: 'rework', attempts: 0, reviewCycles: 0 }
}

function without(counts: Readonly<Record<string, number>>, key: string): Record<string, number> {
  const copy = { ...counts }
  delete copy[key]
  return copy
}
