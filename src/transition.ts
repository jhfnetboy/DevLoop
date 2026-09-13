import { actionKey } from './loop.js'
import type { AgentAction } from './backend.js'
import type { DevloopResult } from './result.js'
import type { HoldReason, LoopState, Task, TaskStatus } from './types.js'

/** result.ts's rule for a task id, held again after the goal prefix is added. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface ApplyAgentResultOptions {
  readonly agent: string
  readonly implementationSha?: string
  /** The checker's size, when the commit is inside the elastic band. */
  readonly overBudget?: string
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
  if (action.type === 'plan') return applyPlan(state, result, options)
  if (action.type === 'delegate') return applyImplementation(state, action.taskId, result, options)
  return applyReview(state, action.taskId, result, options)
}

function applyPlan(state: LoopState, result: DevloopResult, options: ApplyAgentResultOptions): LoopState {
  if (result.kind !== 'plan') throw new Error('result_kind_mismatch: expected plan')
  if (state.tasks.length > 0) throw new Error('stale_agent_result: tasks already exist')
  // From the second goal on, a task's id (and so its branch, devloop/<id>) is the goal's own:
  // planners restart at TASK-001, and an earlier goal's branch of that name may still be on the forge.
  const prefix = state.goal === undefined ? '' : `g${String(state.goal.number)}-`
  const tasks: Task[] = result.tasks.map(task => ({
    ...task,
    id: `${prefix}${task.id}`,
    status: 'ready',
    attempts: 0,
    reviewCycles: 0,
    planner: options.agent,
  }))
  if (tasks.some(task => !TASK_ID.test(task.id))) throw new Error('result_task_mismatch: a task id is too long once the goal prefix is added')
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
    // Per commit: a new attempt is judged on its own size, not the last one's.
    overBudget: options.overBudget,
    implementer: options.agent,
    lastReviewVerdict: undefined,
    reviewer: undefined,
    // Spent only by an attempt that was handed in: a failed or blocked one is retried, and still needs them.
    ...(result.outcome === 'completed' ? { reviewNotes: undefined } : {}),
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
    // Only a request for rework is instructions; a pass's notes are commentary, and nothing follows a replan or a block here.
    reviewNotes: result.verdict === 'REWORK' && result.notes ? result.notes : undefined,
  }))
  if (result.verdict !== 'REPLAN') return next
  return {
    ...next,
    supervisor: { taskId, reason: 'review_requested_replan' satisfies HoldReason },
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
