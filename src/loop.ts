import type { LoopAction, LoopState, Task } from './types.js'

const HIGH_RISK_ACTIVE = new Set<Task['status']>([
  'ready',
  'rework',
  'review_pending',
  'merge_ready',
])

const first = (tasks: readonly Task[], status: Task['status']): Task | undefined =>
  tasks.find(task => task.status === status)

/**
 * Pure outer-loop policy. Must never call an LLM.
 */
export function decideNextAction(state: LoopState): LoopAction {
  if (state.killSwitch) {
    return { type: 'stop', reason: 'kill_switch' }
  }
  if (state.goalCompleted) {
    return { type: 'stop', reason: 'goal_complete' }
  }
  if (state.supervisor) {
    return {
      type: 'escalate',
      taskId: state.supervisor.taskId,
      reason: state.supervisor.reason,
    }
  }

  const highRisk = state.tasks.find(task => task.risk === 'high' && HIGH_RISK_ACTIVE.has(task.status))
  if (highRisk) {
    return { type: 'escalate', taskId: highRisk.id, reason: 'security_high_risk' }
  }

  const failed = first(state.tasks, 'failed')
  if (failed) {
    if (state.tasks.some(task => task.status === 'running')) return { type: 'idle' }
    return { type: 'escalate', taskId: failed.id, reason: 'repeated_test_failure' }
  }

  const blocked = first(state.tasks, 'blocked')
  if (blocked) {
    if (state.tasks.some(task => task.status === 'running')) return { type: 'idle' }
    return { type: 'escalate', taskId: blocked.id, reason: 'blocked_task' }
  }

  const reviewPending = first(state.tasks, 'review_pending')
  if (reviewPending) {
    return { type: 'review', taskId: reviewPending.id }
  }

  const mergeReady = first(state.tasks, 'merge_ready')
  if (mergeReady) {
    return { type: 'merge', taskId: mergeReady.id }
  }

  const ready = first(state.tasks, 'ready') ?? first(state.tasks, 'rework')
  if (ready) {
    return { type: 'delegate', taskId: ready.id }
  }

  if (state.tasks.length === 0) {
    return { type: 'plan' }
  }

  if (state.tasks.some(task => task.status === 'running')) {
    return { type: 'idle' }
  }

  if (state.tasks.every(task => task.status === 'done')) {
    return { type: 'stop', reason: 'goal_complete' }
  }

  return { type: 'idle' }
}

export function actionKey(action: LoopAction): string {
  switch (action.type) {
    case 'stop':
      return `stop:${action.reason}`
    case 'delegate':
    case 'review':
    case 'merge':
      return `${action.type}:${action.taskId}`
    case 'escalate':
      return `escalate:${action.taskId ?? '_'}:${action.reason}`
    default:
      return action.type
  }
}
