import type { BudgetLimits } from './config.js'
import type { BudgetUsage, LoopAction, LoopState } from './types.js'
import { actionKey } from './loop.js'

export type CircuitVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly taskId: string | null }

export function emptyUsage(now: number): BudgetUsage {
  return {
    taskAttempts: counts(),
    refusedDispatches: counts(),
    reviewCycles: counts(),
    taskStartedAt: counts(),
    tokens: counts(),
    costUsdSession: 0,
    costUsdDay: 0,
    lastActions: [],
    lastProgressAt: now,
    parallelWorkers: 0,
  }
}

export function evaluateBudget(
  state: LoopState,
  limits: BudgetLimits,
  now: number,
  next: LoopAction,
): CircuitVerdict {
  const usage = rollCostWindows(state.usage, now)

  if (usage.costUsdDay >= limits.maxCostUsdPerDay) {
    return fail('daily_cost_cap')
  }
  if (usage.costUsdSession >= limits.maxCostUsdPerSession) {
    return fail('session_cost_cap')
  }

  const timedOut = timedOutTaskId(state, limits, now)
  if (timedOut !== undefined) {
    return fail(`task_timeout:${timedOut}`, timedOut)
  }

  // Checked for every action, not just a delegate: once the tick latches, the
  // intended delegate has already been rewritten to idle, and a check that only
  // ran for a delegate would never be reached again.
  const refused = refusedTaskId(usage, limits)
  if (refused !== undefined) {
    return fail(`dispatch_refused:${refused}`, refused)
  }

  if (next.type === 'delegate') {
    const attempts = ownCount(usage.taskAttempts, next.taskId)
    if (attempts >= limits.maxTaskAttempts) {
      return fail(`max_task_attempts:${next.taskId}`, next.taskId)
    }
    const cycles = ownCount(usage.reviewCycles, next.taskId)
    if (cycles >= limits.maxReviewCycles) {
      return fail(`max_review_cycles:${next.taskId}`, next.taskId)
    }
  }

  if (next.type === 'review') {
    const cycles = ownCount(usage.reviewCycles, next.taskId)
    if (cycles >= limits.maxReviewCycles) {
      return fail(`max_review_cycles:${next.taskId}`, next.taskId)
    }
  }

  const overTokens = overTokenTaskId(state, limits)
  if (overTokens !== undefined) {
    return fail('max_tokens_per_task', overTokens)
  }

  if (next.type === 'delegate' || next.type === 'review') {
    const used = ownCount(usage.tokens, next.taskId)
    if (used >= limits.maxTokensPerTask) {
      return fail('max_tokens_per_task', next.taskId)
    }
  }

  const key = actionKey(next)
  if (next.type !== 'idle' && next.type !== 'stop') {
    const same = countTrailing(usage.lastActions, key)
    if (same >= limits.maxSameAction) {
      return fail(`duplicate_action:${key}`, taskIdOf(next))
    }
  }

  const idleMs = now - usage.lastProgressAt
  if (idleMs >= limits.noProgressMinutes * 60_000 && next.type === 'idle') {
    return fail('no_progress')
  }

  return { ok: true }
}

export function recordAction(usage: BudgetUsage, action: LoopAction, now: number): BudgetUsage {
  const key = actionKey(action)
  const lastActions = [...usage.lastActions, key].slice(-20)
  const taskAttempts = counts(usage.taskAttempts)
  const refusedDispatches = counts(usage.refusedDispatches)
  const taskStartedAt = counts(usage.taskStartedAt)
  const reviewCycles = counts(usage.reviewCycles)
  if (action.type === 'delegate') {
    taskAttempts[action.taskId] = ownCount(taskAttempts, action.taskId) + 1
    if (!Object.hasOwn(taskStartedAt, action.taskId)) {
      taskStartedAt[action.taskId] = now
    }
  }
  if (action.type === 'review') {
    reviewCycles[action.taskId] = ownCount(reviewCycles, action.taskId) + 1
  }
  const progressed = action.type !== 'idle' && action.type !== 'stop'
  const rolled = rollCostWindows(usage, now)
  return {
    ...rolled,
    lastActions,
    taskAttempts,
    refusedDispatches,
    taskStartedAt,
    reviewCycles,
    lastProgressAt: progressed ? now : rolled.lastProgressAt,
  }
}

/** Reset daily cost at UTC midnight; optionally zero the session counter. */
export function rollCostWindows(
  usage: BudgetUsage,
  now: number,
  resetSession = false,
): BudgetUsage {
  const sameDay = utcDay(usage.lastProgressAt) === utcDay(now)
  return {
    ...usage,
    costUsdSession: resetSession ? 0 : usage.costUsdSession,
    costUsdDay: sameDay ? usage.costUsdDay : 0,
  }
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Fold optional backend token/cost signals into usage. Missing signals are a no-op. */
/**
 * Give back what a dispatch that never ran should not have been charged.
 *
 * `recordAction` charges when work is sent out, which is right: a run that
 * starts and fails has still been attempted. But a dispatch refused before any
 * provider saw it — a bad route, a missing adapter, a precondition the operator
 * has to fix — spent nothing, and letting it eat a task's attempts means the
 * budget runs out on a misconfiguration that retrying cannot fix.
 *
 * Never goes below zero, and touches nothing else: the duplicate-action window
 * and the task's start time still record that the loop tried.
 */
export function refundAction(usage: BudgetUsage, action: LoopAction): BudgetUsage {
  if (action.type === 'delegate') {
    return {
      ...usage,
      taskAttempts: decrement(usage.taskAttempts, action.taskId),
      // The refund is what makes the attempt free; this is what keeps it
      // counted. Without it the task nets back to zero every cycle and
      // `max_task_attempts` can never fire for the misconfiguration the
      // refund exists to forgive.
      refusedDispatches: increment(usage.refusedDispatches, action.taskId),
    }
  }
  if (action.type === 'review') {
    return { ...usage, reviewCycles: decrement(usage.reviewCycles, action.taskId) }
  }
  return usage
}

function increment(counts_: Readonly<Record<string, number>>, taskId: string): Record<string, number> {
  const next = counts(counts_)
  next[taskId] = ownCount(next, taskId) + 1
  return next
}

function decrement(counts_: Readonly<Record<string, number>>, taskId: string): Record<string, number> {
  const next = counts(counts_)
  const current = ownCount(next, taskId)
  if (current <= 0) return next
  next[taskId] = current - 1
  return next
}

export function applyRunSignals(
  usage: BudgetUsage,
  taskId: string | null,
  now: number,
  signals: { readonly tokens?: number; readonly costUsd?: number },
): BudgetUsage {
  const rolled = rollCostWindows(usage, now)
  const tokens = counts(rolled.tokens)
  if (taskId && finitePositive(signals.tokens)) {
    tokens[taskId] = ownCount(tokens, taskId) + signals.tokens
  }
  let costUsdSession = rolled.costUsdSession
  let costUsdDay = rolled.costUsdDay
  if (finitePositive(signals.costUsd)) {
    costUsdSession += signals.costUsd
    costUsdDay += signals.costUsd
  }
  return { ...rolled, tokens, costUsdSession, costUsdDay, lastProgressAt: now }
}

function finitePositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

const TERMINAL_STATUS = new Set(['done', 'failed'])

function lifetimeMinutes(limits: BudgetLimits): number {
  return Math.max(limits.taskLifetimeMinutes, limits.taskTimeoutMinutes * limits.maxTaskAttempts)
}

function timedOutTaskId(state: LoopState, limits: BudgetLimits, now: number): string | undefined {
  for (const [taskId, started] of Object.entries(state.usage.taskStartedAt)) {
    if (typeof started !== 'number') continue
    const task = state.tasks.find(entry => entry.id === taskId)
    if (!task || TERMINAL_STATUS.has(task.status)) continue
    if ((now - started) / 60_000 >= lifetimeMinutes(limits)) return taskId
  }
}

function overTokenTaskId(state: LoopState, limits: BudgetLimits): string | undefined {
  for (const task of state.tasks) {
    if (task.status !== 'running') continue
    if (ownCount(state.usage.tokens, task.id) >= limits.maxTokensPerTask) return task.id
  }
}

function counts(source: Readonly<Record<string, number>> = {}): Record<string, number> {
  return Object.assign(Object.create(null) as Record<string, number>, source)
}

function ownCount(record: Readonly<Record<string, number>>, id: string): number {
  return Object.hasOwn(record, id) ? record[id] ?? 0 : 0
}

function refusedTaskId(usage: BudgetUsage, limits: BudgetLimits): string | undefined {
  for (const [taskId, refused] of Object.entries(usage.refusedDispatches)) {
    if (refused >= limits.maxRefusedDispatches) return taskId
  }
  return undefined
}

function fail(reason: string, taskId: string | null = null): CircuitVerdict {
  return { ok: false, reason, taskId }
}

function taskIdOf(action: LoopAction): string | null {
  if (action.type === 'delegate' || action.type === 'review' || action.type === 'merge') {
    return action.taskId
  }
  if (action.type === 'escalate') return action.taskId
  return null
}

function countTrailing(actions: readonly string[], key: string): number {
  let count = 0
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    if (actions[i] !== key) break
    count += 1
  }
  return count
}
