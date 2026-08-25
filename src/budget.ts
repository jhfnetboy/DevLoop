import type { BudgetLimits } from './config.js'
import type { BudgetUsage, LoopAction, LoopState } from './types.js'
import { actionKey } from './loop.js'

export type CircuitVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly taskId: string | null }

export function emptyUsage(now: number): BudgetUsage {
  return {
    taskAttempts: {},
    reviewCycles: {},
    taskStartedAt: {},
    tokens: {},
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
  const usage = state.usage

  if (usage.costUsdDay >= limits.maxCostUsdPerDay) {
    return fail('daily_cost_cap')
  }
  if (usage.costUsdSession >= limits.maxCostUsdPerSession) {
    return fail('session_cost_cap')
  }
  if (usage.parallelWorkers >= limits.maxParallelWorkers && next.type === 'delegate') {
    return fail('max_parallel_workers', next.taskId)
  }

  const timedOut = timedOutTaskId(state, limits, now)
  if (timedOut) {
    return fail(`task_timeout:${timedOut}`, timedOut)
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
  const taskAttempts = { ...usage.taskAttempts }
  const taskStartedAt = { ...usage.taskStartedAt }
  const reviewCycles = { ...usage.reviewCycles }
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
  return {
    ...usage,
    lastActions,
    taskAttempts,
    taskStartedAt,
    reviewCycles,
    lastProgressAt: progressed ? now : usage.lastProgressAt,
  }
}

const TERMINAL_STATUS = new Set(['done', 'failed'])

function timedOutTaskId(state: LoopState, limits: BudgetLimits, now: number): string | undefined {
  for (const [taskId, started] of Object.entries(state.usage.taskStartedAt)) {
    if (typeof started !== 'number') continue
    const task = state.tasks.find(entry => entry.id === taskId)
    if (!task || TERMINAL_STATUS.has(task.status)) continue
    if ((now - started) / 60_000 >= limits.taskTimeoutMinutes) return taskId
  }
}

function ownCount(record: Readonly<Record<string, number>>, id: string): number {
  return Object.hasOwn(record, id) ? record[id] ?? 0 : 0
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
