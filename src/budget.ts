import type { BudgetLimits } from './config.js'
import type { BudgetUsage, LoopAction, LoopState } from './types.js'
import { actionKey } from './loop.js'

export type CircuitVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export function emptyUsage(now: number): BudgetUsage {
  return {
    taskAttempts: {},
    reviewCycles: {},
    taskStartedAt: {},
    tokens: 0,
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
    return { ok: false, reason: 'daily_cost_cap' }
  }
  if (usage.costUsdSession >= limits.maxCostUsdPerSession) {
    return { ok: false, reason: 'session_cost_cap' }
  }
  if (usage.parallelWorkers >= limits.maxParallelWorkers && next.type === 'delegate') {
    return { ok: false, reason: 'max_parallel_workers' }
  }

  if (next.type === 'delegate') {
    const attempts = usage.taskAttempts[next.taskId] ?? 0
    if (attempts >= limits.maxTaskAttempts) {
      return { ok: false, reason: `max_task_attempts:${next.taskId}` }
    }
    const started = usage.taskStartedAt[next.taskId]
    if (started !== undefined) {
      const elapsedMin = (now - started) / 60_000
      if (elapsedMin >= limits.taskTimeoutMinutes) {
        return { ok: false, reason: `task_timeout:${next.taskId}` }
      }
    }
  }

  if (next.type === 'review') {
    const cycles = usage.reviewCycles[next.taskId] ?? 0
    if (cycles >= limits.maxReviewCycles) {
      return { ok: false, reason: `max_review_cycles:${next.taskId}` }
    }
  }

  if (usage.tokens >= limits.maxTokensPerTask && (next.type === 'delegate' || next.type === 'review')) {
    return { ok: false, reason: 'max_tokens_per_task' }
  }

  const key = actionKey(next)
  if (next.type !== 'idle' && next.type !== 'stop') {
    const same = countTrailing(usage.lastActions, key)
    if (same >= limits.maxSameAction) {
      return { ok: false, reason: `duplicate_action:${key}` }
    }
  }

  const idleMs = now - usage.lastProgressAt
  if (idleMs >= limits.noProgressMinutes * 60_000 && next.type === 'idle') {
    return { ok: false, reason: 'no_progress' }
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
    taskAttempts[action.taskId] = (taskAttempts[action.taskId] ?? 0) + 1
    if (taskStartedAt[action.taskId] === undefined) {
      taskStartedAt[action.taskId] = now
    }
  }
  if (action.type === 'review') {
    reviewCycles[action.taskId] = (reviewCycles[action.taskId] ?? 0) + 1
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

function countTrailing(actions: readonly string[], key: string): number {
  let count = 0
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    if (actions[i] !== key) break
    count += 1
  }
  return count
}
