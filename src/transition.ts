import { actionKey } from './loop.js'
import type { AgentAction } from './backend.js'
import type { DevloopResult } from './result.js'
import type { LoopState, Task, TaskStatus } from './types.js'

export interface ApplyAgentResultOptions {
  readonly agent: string
  readonly implementationSha?: string
}

/** Pure, fail-closed conversion from a validated model result to domain state. */
export function applyAgentResult(
  state: LoopState,
  action: AgentAction,
  result: DevloopResult,
  options: ApplyAgentResultOptions,
): LoopState {
  if (actionKey(state.lastAction) !== actionKey(action)) {
    throw new Error('stale_agent_result: action no longer current')
  }
  if (action.type === 'plan') return applyPlan(state, result)
  if (action.type === 'delegate') return applyImplementation(state, action.taskId, result, options)
  return applyReview(state, action.taskId, result, options)
}

function applyPlan(state: LoopState, result: DevloopResult): LoopState {
  if (result.kind !== 'plan') throw new Error('result_kind_mismatch: expected plan')
  if (state.tasks.length > 0) throw new Error('stale_agent_result: tasks already exist')
  const tasks: Task[] = result.tasks.map(task => ({
    ...task,
    status: 'ready',
    attempts: 0,
    reviewCycles: 0,
  }))
  return { ...state, tasks }
}

function applyImplementation(
  state: LoopState,
  taskId: string,
  result: DevloopResult,
  options: ApplyAgentResultOptions,
): LoopState {
  if (result.kind !== 'implementation') throw new Error('result_kind_mismatch: expected implementation')
  if (result.taskId !== taskId) throw new Error('result_task_mismatch')
  let status: TaskStatus
  if (result.outcome === 'completed') {
    if (!options.implementationSha) throw new Error('implementation result has no host commit SHA')
    status = 'review_pending'
  } else if (result.outcome === 'blocked') {
    status = 'blocked'
  } else {
    status = 'rework'
  }
  return updateTask(state, taskId, task => ({
    ...task,
    status,
    attempts: state.usage.taskAttempts[taskId] ?? task.attempts,
    ...(options.implementationSha === undefined ? {} : { implementationSha: options.implementationSha }),
    implementer: options.agent,
    lastReviewVerdict: undefined,
    reviewer: undefined,
  }))
}

function applyReview(
  state: LoopState,
  taskId: string,
  result: DevloopResult,
  options: ApplyAgentResultOptions,
): LoopState {
  if (result.kind !== 'review') throw new Error('result_kind_mismatch: expected review')
  if (result.taskId !== taskId) throw new Error('result_task_mismatch')
  const task = state.tasks.find(entry => entry.id === taskId)
  if (!task) throw new Error('result_task_missing')
  if (!task.implementationSha || result.reviewedSha !== task.implementationSha) {
    throw new Error('stale_review_sha')
  }
  if (task.implementer && task.implementer === options.agent) {
    throw new Error('reviewer_identity_matches_implementer')
  }
  const status: TaskStatus = result.verdict === 'PASS' || result.verdict === 'PASS_WITH_NOTES'
    ? 'merge_ready'
    : result.verdict === 'REWORK'
      ? 'rework'
      : 'blocked'
  const next = updateTask(state, taskId, entry => ({
    ...entry,
    status,
    reviewCycles: state.usage.reviewCycles[taskId] ?? entry.reviewCycles,
    lastReviewVerdict: result.verdict,
    reviewer: options.agent,
  }))
  if (result.verdict !== 'REPLAN') return next
  return {
    ...next,
    supervisor: { taskId, reason: 'review_requested_replan' },
  }
}

function updateTask(state: LoopState, taskId: string, update: (task: Task) => Task): LoopState {
  let found = false
  const tasks = state.tasks.map(task => {
    if (task.id !== taskId) return task
    found = true
    return update(task)
  })
  if (!found) throw new Error('result_task_missing')
  return { ...state, tasks }
}
