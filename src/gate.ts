import type { BudgetLimits } from './config.js'
import { diagnoseHalt, integrityHold, liftHold, resumeState } from './resume.js'
import type { BaseReason, CircuitReason, HoldReason, LoopState, Task } from './types.js'

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

  // A pause asks nothing: the operator stopped a healthy loop and the only
  // reply is to resume it. Posing a question here would invent a decision.
  if (state.paused && state.supervisor === null) return null
  // A finished goal asks nothing either. The generic question below — "redo the
  // task, or leave it?" — read to an operator as if a finished project had gone
  // wrong. Reopening work is `resume --task`, a deliberate act, not an answer.
  if (state.goalCompleted && state.supervisor === null) return null

  const reason = state.supervisor?.reason ?? diagnosis.wouldHaltAgain ?? 'unknown'
  const taskId = diagnosis.taskId
  const task = taskId === null ? undefined : state.tasks.find(entry => entry.id === taskId)
  const base = reason.split(':')[0] ?? reason
  const compose = KNOWN_GATES[base as KnownReasonBase]
  if (compose === undefined) {
    // Genuinely open: `stop:*`, `escalate:*` and the message from a resume that
    // refused. Both closed families are covered by KNOWN_GATES, so a reason
    // reaching here is one no code in this repo writes as a hold or a circuit.
    return gate(reason, taskId, 'The loop stopped and needs a decision. Redo the task, or leave it?', [
      `the recorded reason is ${reason}`,
    ], taskId === null ? [STOP] : [RETRY, STOP])
  }
  return compose({ reason, taskId, task, limits, base })
}

interface GateContext {
  readonly reason: string
  readonly taskId: string | null
  readonly task: Task | undefined
  readonly limits: BudgetLimits
  readonly base: string
}

/**
 * Every reason this repo writes, and the question it becomes.
 *
 * Exhaustive over both closed families by construction: adding a member to
 * `HoldReason` or `CircuitReason` without an entry here is a compile error, not
 * a halt that reaches an operator as "the loop stopped and needs a decision".
 * That generic gate was the whole complaint; typing the write sites alone only
 * caught misspellings.
 */
type KnownReasonBase = BaseReason<HoldReason> | BaseReason<CircuitReason>

const KNOWN_GATES: Record<KnownReasonBase, (ctx: GateContext) => Gate> = {
  empty_task: ({ reason, taskId }) =>
    gate(reason, taskId, 'The task branch has no commits, but review passed it. Did it need any change?', [
      `${label(taskId)} is still at the commit it started from`,
      'a review verdict of PASS is recorded against it',
    ], [RETRY, ACCEPT, STOP]),

  scope_violation: scopeGate,
  scope_check_failed: scopeGate,

  no_review_pass: ({ reason, taskId, task }) =>
    gate(reason, taskId, 'The task is ready to merge with no passing review. Review it again, or redo it?', [
      `${label(taskId)} is merge_ready`,
      `its last verdict was ${task?.lastReviewVerdict ?? 'none'}`,
    ], [REVIEW, RETRY, STOP]),

  stale_review_sha: staleShaGate,
  unknown_review_sha: staleShaGate,

  reviewer_identity_conflict: ({ reason, taskId }) =>
    gate(reason, taskId, 'The reviewer was the same identity that implemented the task. Review it again?', [
      `${label(taskId)} was reviewed by its own implementer`,
      'a verdict from the implementer is never accepted',
    ], [REVIEW, STOP], 'Point reviewerRoute at a different provider than the tier that implements.'),

  security_high_risk: ({ reason, taskId }) =>
    gate(reason, taskId, 'This task is marked high risk, so policy sends it to a person. Proceed how?', [
      `${label(taskId)} has risk: high`,
      'high-risk tasks are never merged without a human deciding',
    ], [STOP], 'Read the diff yourself, then merge it by hand or lower the risk in the plan and retry.'),

  max_task_attempts: attemptsGate,
  repeated_test_failure: attemptsGate,

  max_review_cycles: ({ reason, taskId, limits }) =>
    gate(reason, taskId, 'Review keeps sending the task back. Redo it, or leave it?', [
      `${label(taskId)} reached ${String(limits.maxReviewCycles)} review cycles`,
    ], [RETRY, STOP]),

  daily_cost_cap: costGate,
  session_cost_cap: costGate,
  max_tokens_per_task: costGate,

  blocked_task: ({ reason, taskId, task }) =>
    gate(reason, taskId, 'The task reported itself blocked. Redo it, or leave it?', [
      `${label(taskId)} is blocked`,
      task?.lastReviewVerdict ? `its last verdict was ${task.lastReviewVerdict}` : 'no verdict is recorded',
    ], [RETRY, STOP]),

  merge_wedged: mergeGate,
  unknown_base: mergeGate,

  // The task itself is fine and still merge_ready; only where it would land is
  // wrong. Redoing it would pay for the same change again, so the answer is to
  // move the checkout and resume, which merges on the next tick.
  merge_onto_trunk: ({ reason, taskId }) =>
    gate(reason, taskId, 'The checkout is on a trunk branch, so the reviewed task was not merged. Move it back to the work branch, then resume?', [
      `${label(taskId)} passed review and is waiting to merge`,
      'DevLoop merges into the checked-out branch locally, and never into main, master or the configured base',
    ], [STOP], 'Switch the checkout back to the branch the loop was started on (e.g. git switch <work-branch>), then resume (恢复循环 on the page, or devloop resume); the task merges on the next tick.'),

  merge_detached_head: ({ reason, taskId }) =>
    gate(reason, taskId, 'The checkout has no branch, so the reviewed task was not merged. Check out the work branch, then resume?', [
      `${label(taskId)} passed review and is waiting to merge`,
      'HEAD is detached, and there is no branch to merge into',
    ], [STOP], 'Check out the branch the loop was started on (e.g. git switch <work-branch>), then resume (恢复循环 on the page, or devloop resume); the task merges on the next tick.'),

  dispatch_refused: ({ reason, taskId, limits }) =>
    gate(reason, taskId, 'The provider refused to start this task, so nothing has run. Fix the route, or leave it?', [
      `dispatching ${label(taskId)} was refused ${String(limits.maxRefusedDispatches)} times without reaching a model`,
      'nothing was spent, and nothing will change on its own',
    ], [RETRY, STOP], "Check agentBackend and the task's route resolve to a provider that exists, then retry."),

  // The reviewer asked for a different *plan*, and `retry` means running the
  // same task again under the plan that was just rejected — an answer to a
  // question nobody asked.
  review_requested_replan: ({ reason, taskId }) =>
    gate(reason, taskId, 'The reviewer asked for the plan to change, not for the task to run again. Replan, or leave it?', [
      `review of ${label(taskId)} returned REPLAN`,
      'the work is untouched; it is the plan that was rejected',
    ], [STOP], `Edit the task in .devloop/PLAN.md to reflect the review, then: devloop resume --task ${taskId ?? '<id>'}`),

  acceptance_failed: ({ reason, taskId }) =>
    gate(reason, taskId, 'The task did not pass the checks this workspace requires. Redo it, or leave it?', [
      `${label(taskId)} failed: ${reason.slice('acceptance_failed:'.length).trim() || 'an acceptance check'}`,
      'the commit exists but was never offered for review',
    ], [RETRY, STOP], 'Run the same command in .devloop/worktrees/<task> to see the output.'),

  // These two were written by `transitionFailureReason` and had no question at
  // all until the table made their absence a compile error.
  invalid_agent_result: ({ reason, taskId }) =>
    gate(reason, taskId, 'The agent returned a result for the wrong task or the wrong kind of work. Redo it, or leave it?', [
      `the result rejected for ${label(taskId)} did not match what was dispatched`,
      'nothing was recorded from it, so the task is where it was',
    ], [RETRY, STOP]),

  result_transition_failed: ({ reason, taskId }) =>
    gate(reason, taskId, 'The result could not be applied to the recorded state. Redo the task, or leave it?', [
      `applying the result for ${label(taskId)} was refused`,
      'the state is unchanged, so retrying is safe',
    ], [RETRY, STOP]),

  backend_failed: ({ reason, taskId }) =>
    gate(reason, taskId, 'The backend failed after a model had already been reached. Redo the task, or leave it?', [
      `the dispatch for ${label(taskId)} failed after reaching a provider`,
      'the attempt was spent, because it was one',
    ], [RETRY, STOP]),

  parent_commit_failed: ({ reason, taskId }) =>
    gate(reason, taskId, "The task's work could not be committed. Redo it, or fix the worktree by hand?", [
      `committing ${label(taskId)} failed`,
      'nothing was merged, so the workspace is unchanged',
    ], [RETRY, STOP], 'Check the task worktree for a lock or a conflicted index, then retry.'),

  missing_review_worktree: ({ reason, taskId }) =>
    gate(reason, taskId, 'The worktree the review needed is gone. Redo the task, or leave it?', [
      `${label(taskId)} has no worktree to review`,
      'a review is only accepted against the tree it names',
    ], [RETRY, STOP]),

  missing_agent_result: ({ reason, taskId }) =>
    gate(reason, taskId, 'The agent started and returned no result. Redo the task, or leave it?', [
      `the dispatch for ${label(taskId)} produced no result to record`,
    ], [RETRY, STOP]),

  no_progress: ({ reason, taskId }) =>
    gate(reason, taskId, 'The loop stopped making progress. Redo the task it was on, or leave it?', [
      'no action changed anything for longer than the profile allows',
      taskId === null ? 'no single task is named, so this is about the loop' : `the last task was ${taskId}`,
    ], taskId === null ? [STOP] : [RETRY, STOP]),

  duplicate_action: ({ reason, taskId }) =>
    gate(reason, taskId, 'The loop kept choosing the same action without it changing anything. Redo the task, or leave it?', [
      `the repeated action was ${reason.slice('duplicate_action:'.length) || 'the same one'}`,
    ], taskId === null ? [STOP] : [RETRY, STOP]),

  task_timeout: ({ reason, taskId }) =>
    gate(reason, taskId, 'The task used its whole lifetime without finishing. Spend more, or leave it?', [
      `${label(taskId)} ran past the lifetime the profile allows`,
      'retrying clears its counters and starts the budget again',
    ], [RETRY, STOP]),
}

function scopeGate({ reason, taskId }: GateContext): Gate {
  return gate(reason, taskId, 'The worker wrote outside the paths this task was allowed. Retry, or change the plan?', [
    `${label(taskId)} touched a path outside its allowedPaths`,
    'nothing was committed, so the workspace is unchanged',
  ], [RETRY, STOP], 'To let the task write there, widen allowedPaths in the plan and retry.')
}

function staleShaGate({ reason, taskId }: GateContext): Gate {
  return gate(reason, taskId, 'The review does not match the commit under review. Review the current commit, or redo the task?', [
    `${label(taskId)} moved after its review was requested`,
    'a verdict is only accepted for the exact commit it names',
  ], [REVIEW, RETRY, STOP])
}

function attemptsGate({ reason, taskId, limits }: GateContext): Gate {
  return gate(reason, taskId, 'The task has used its attempts without succeeding. Spend more, or leave it?', [
    `${label(taskId)} reached ${String(limits.maxTaskAttempts)} attempts`,
    'retrying clears its counters and starts the budget again',
  ], [RETRY, STOP])
}

function mergeGate({ reason, taskId }: GateContext): Gate {
  return gate(reason, taskId, 'The merge could not be completed safely. Redo the task, or fix the tree by hand?', [
    `merging ${label(taskId)} was refused: ${reason}`,
    'the workspace was left untouched',
  ], [RETRY, STOP], 'Check the primary worktree is clean and on a branch, then retry.')
}

function costGate({ reason, taskId, base }: GateContext): Gate {
  return gate(reason, taskId, 'The loop reached a spending limit. Raise it, or stop here?', [
    `the ${base.replace(/_/g, ' ')} was reached`,
    'the limit is a decision, so nothing here clears it on its own',
  ], [STOP], 'Raise the limit in the profile and restart, or clear the window with: devloop resume --reset-cost')
}

/**
 * Apply an answer. Pure, like the resume it builds on; the caller persists it
 * under the lock.
 *
 * Only `retry` is a resume. `retry` means "throw the attempt away and start
 * over", so it spends a fresh budget and `resumeState` clears the task's
 * counters to match. `review` and `accept` keep the work that exists, so they
 * must keep the budget that bought it: they lift the hold and nothing else.
 * Routing them through `resumeState` handed a task a fresh `maxReviewCycles`
 * every time an operator answered, and dropped the task's start time — which
 * only a `delegate` ever writes back, so the lifetime circuit stopped seeing a
 * task that stayed in review.
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
  if (key === 'stop') return acknowledge(state, gate, now)
  const taskId = gate.taskId
  if (taskId === null) throw new Error(`gate: ${key} needs a task, and this halt names none`)

  if (key === 'retry') return resumeState(state, { taskId }, now)

  const lifted = liftHold(state, now, 'answer')
  return {
    ...lifted,
    // Reopening a task is the only thing that makes a finished goal unfinished.
    goalCompleted: false,
    tasks: lifted.tasks.map(task => task.id === taskId ? afterAnswer(task, key) : task),
    updatedAt: new Date(now).toISOString(),
  }
}

/**
 * `review` sends the commit that already exists back for a verdict, so the work
 * is not thrown away. `accept` is the operator agreeing the task needed no
 * change; it is the only path that marks a task done without a merge.
 *
 * The stale verdict goes either way: `review` is asking for a new one, and
 * `accept` is the operator standing in for one.
 */
function afterAnswer(task: Task, key: 'review' | 'accept'): Task {
  const { lastReviewVerdict: _verdict, reviewer: _reviewer, ...rest } = task
  if (key === 'accept') return { ...rest, status: 'done' }
  return { ...rest, status: 'review_pending' }
}

/**
 * `stop` leaves every task and the hold itself alone, and records that a person
 * decided so. Without the record, an unanswered halt and a deliberately
 * declined one are indistinguishable in `.devloop/`.
 */
function acknowledge(state: LoopState, gate: Gate, now: number): LoopState {
  return {
    ...state,
    acknowledged: { at: new Date(now).toISOString(), reason: gate.reason, taskId: gate.taskId },
    updatedAt: new Date(now).toISOString(),
  }
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
