import type { BudgetLimits } from './config.js'
import { diagnoseHalt, integrityHold, resumeState } from './resume.js'
import type { LoopState, Task } from './types.js'

/** One thing the operator can say back, and what saying it does. */
export interface GateOption {
  /** What they type. */
  readonly key: 'retry' | 'review' | 'accept' | 'stop'
  readonly summary: string
}

/**
 * A halt, restated as a question someone can answer.
 *
 * A supervisor hold records what broke — `empty_task`, `scope_violation`. That
 * tells an operator to go and read code before they can even tell what decision
 * is being asked of them. A gate names the decision instead, and lists answers
 * the loop can act on, so the halt is a question with a reply rather than a
 * signal that a human is needed somewhere.
 */
export interface Gate {
  /** The underlying hold, kept so nothing is lost in translation. */
  readonly reason: string
  readonly taskId: string | null
  readonly question: string
  /** What the loop observed, in the terms the question is asked in. */
  readonly evidence: readonly string[]
  readonly options: readonly GateOption[]
  /** Set when no answer this tool can apply would help. */
  readonly manual: string | null
}

const RETRY: GateOption = { key: 'retry', summary: 'give the task another attempt from a clean worktree' }
const REVIEW: GateOption = { key: 'review', summary: 'send the existing commit back for review' }
const ACCEPT: GateOption = { key: 'accept', summary: 'agree the task needed no change and mark it done' }
const STOP: GateOption = { key: 'stop', summary: 'leave the loop halted; nothing changes' }

/** The question a halted loop is really asking, or null when it is not halted. */
export function gateFor(state: LoopState, limits: BudgetLimits, now: number): Gate | null {
  const diagnosis = diagnoseHalt(state, limits, now)
  if (!diagnosis.halted) return null

  const integrity = integrityHold(state)
  if (integrity !== null) {
    return {
      reason: integrity,
      taskId: null,
      question: 'The recorded state could not be read back. What should it be?',
      evidence: [
        `the host replaced STATE.json with a halted placeholder (${integrity})`,
        'the task history is not in it',
      ],
      options: [STOP],
      manual: 'Repair or restore .devloop/STATE.json, or recover it from EVENTS.jsonl, before resuming.',
    }
  }

  const reason = state.supervisor?.reason ?? diagnosis.wouldHaltAgain ?? 'unknown'
  const taskId = diagnosis.taskId
  const task = taskId === null ? undefined : state.tasks.find(entry => entry.id === taskId)
  const base = reason.split(':')[0] ?? reason

  switch (base) {
    case 'empty_task':
      return gate(reason, taskId, 'The task branch has no commits, but review passed it. Did it need any change?', [
        `${label(taskId)} is still at the commit it started from`,
        'a review verdict of PASS is recorded against it',
      ], [RETRY, ACCEPT, STOP])

    case 'scope_violation':
    case 'scope_check_failed':
      return gate(reason, taskId, 'The worker wrote outside the paths this task was allowed. Retry, or change the plan?', [
        `${label(taskId)} touched a path outside its allowedPaths`,
        'nothing was committed, so the workspace is unchanged',
      ], [RETRY, STOP], 'To let the task write there, widen allowedPaths in the plan and retry.')

    case 'no_review_pass':
      return gate(reason, taskId, 'The task is ready to merge with no passing review. Review it again, or redo it?', [
        `${label(taskId)} is merge_ready`,
        `its last verdict was ${task?.lastReviewVerdict ?? 'none'}`,
      ], [REVIEW, RETRY, STOP])

    case 'stale_review_sha':
    case 'unknown_review_sha':
      return gate(reason, taskId, 'The review does not match the commit under review. Review the current commit, or redo the task?', [
        `${label(taskId)} moved after its review was requested`,
        'a verdict is only accepted for the exact commit it names',
      ], [REVIEW, RETRY, STOP])

    case 'reviewer_identity_conflict':
      return gate(reason, taskId, 'The reviewer was the same identity that implemented the task. Review it again?', [
        `${label(taskId)} was reviewed by its own implementer`,
        'a verdict from the implementer is never accepted',
      ], [REVIEW, STOP], 'Point reviewerRoute at a different provider than the tier that implements.')

    case 'security_high_risk':
      return gate(reason, taskId, 'This task is marked high risk, so policy sends it to a person. Proceed how?', [
        `${label(taskId)} has risk: high`,
        'high-risk tasks are never merged without a human deciding',
      ], [STOP], 'Read the diff yourself, then merge it by hand or lower the risk in the plan and retry.')

    case 'max_task_attempts':
    case 'repeated_test_failure':
      return gate(reason, taskId, 'The task has used its attempts without succeeding. Spend more, or leave it?', [
        `${label(taskId)} reached ${limits.maxTaskAttempts} attempts`,
        'retrying clears its counters and starts the budget again',
      ], [RETRY, STOP])

    case 'max_review_cycles':
      return gate(reason, taskId, 'Review keeps sending the task back. Redo it, or leave it?', [
        `${label(taskId)} reached ${limits.maxReviewCycles} review cycles`,
      ], [RETRY, STOP])

    case 'daily_cost_cap':
    case 'session_cost_cap':
    case 'max_tokens_per_task':
      return gate(reason, taskId, 'The loop reached a spending limit. Raise it, or stop here?', [
        `the ${base.replace(/_/g, ' ')} was reached`,
        'the limit is a decision, so nothing here clears it on its own',
      ], [STOP], 'Raise the limit in the profile and restart, or clear the window with: devloop resume --reset-cost')

    case 'blocked_task':
      return gate(reason, taskId, 'The task reported itself blocked. Redo it, or leave it?', [
        `${label(taskId)} is blocked`,
        task?.lastReviewVerdict ? `its last verdict was ${task.lastReviewVerdict}` : 'no verdict is recorded',
      ], [RETRY, STOP])

    case 'merge_wedged':
    case 'unknown_base':
      return gate(reason, taskId, 'The merge could not be completed safely. Redo the task, or fix the tree by hand?', [
        `merging ${label(taskId)} was refused: ${reason}`,
        'the workspace was left untouched',
      ], [RETRY, STOP], 'Check the primary worktree is clean and on a branch, then retry.')

    default:
      return gate(reason, taskId, 'The loop stopped and needs a decision. Redo the task, or leave it?', [
        `the recorded reason is ${reason}`,
      ], taskId === null ? [STOP] : [RETRY, STOP])
  }
}

/**
 * Apply an answer. Pure, like the resume it builds on; the caller persists it
 * under the lock. Returns the state unchanged for `stop`, which is a decision
 * to leave things alone rather than a no-op.
 */
export function applyAnswer(
  state: LoopState,
  gate: Gate,
  key: GateOption['key'],
  now: number,
): LoopState {
  if (!gate.options.some(option => option.key === key)) {
    throw new Error(`gate: ${key} is not an answer to this question`)
  }
  if (key === 'stop') return state
  const taskId = gate.taskId
  if (taskId === null) throw new Error(`gate: ${key} needs a task, and this halt names none`)

  const resumed = resumeState(state, { taskId }, now)
  if (key === 'retry') return resumed

  return {
    ...resumed,
    tasks: resumed.tasks.map(task => task.id === taskId ? afterAnswer(task, key) : task),
  }
}

/**
 * `review` sends the commit that already exists back for a verdict, so the work
 * is not thrown away. `accept` is the operator agreeing the task needed no
 * change; it is the only path that marks a task done without a merge.
 */
function afterAnswer(task: Task, key: 'review' | 'accept'): Task {
  if (key === 'accept') return { ...task, status: 'done' }
  return { ...task, status: 'review_pending' }
}

function gate(
  reason: string,
  taskId: string | null,
  question: string,
  evidence: readonly string[],
  options: readonly GateOption[],
  manual: string | null = null,
): Gate {
  return { reason, taskId, question, evidence, options, manual }
}

function label(taskId: string | null): string {
  return taskId === null ? 'the task' : `task ${taskId}`
}
