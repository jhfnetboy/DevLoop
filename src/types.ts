/**
 * Domain types for the engineering loop.
 * File-backed state lives under `<workspace>/.devloop/`.
 */

export type ModelTier = 'T0' | 'T1' | 'T2' | 'T3'

export type TaskStatus =
  | 'ready'
  | 'running'
  | 'review_pending'
  | 'merge_ready'
  | 'rework'
  | 'blocked'
  | 'done'
  | 'failed'

export type ReviewVerdict = 'PASS' | 'PASS_WITH_NOTES' | 'REWORK' | 'REPLAN' | 'BLOCKED'

export type Risk = 'low' | 'medium' | 'high'

export interface Task {
  readonly id: string
  readonly title: string
  readonly tier: ModelTier
  readonly status: TaskStatus
  readonly risk: Risk
  readonly attempts: number
  readonly reviewCycles: number
  readonly allowedPaths: readonly string[]
  readonly acceptance: readonly string[]
  readonly lastReviewVerdict?: ReviewVerdict
  /** Git SHA of the task branch at delegate. Merge refuses if the branch is still this. */
  readonly baseSha?: string
  /** Host-created implementation commit that the independent review must bind to. */
  readonly implementationSha?: string
  /**
   * Set when that commit is over the PR size budget but inside its elastic band:
   * it goes to review rather than back to planning, and the reviewer is told why
   * it is bigger than asked, to judge whether it should have been split.
   */
  readonly overBudget?: string
  /** The planner's size estimate, recorded to judge estimates by; nothing refuses a task for missing it. */
  readonly estimate?: { readonly lines: number, readonly files: number }
  /** Provider/model identity that planned this task; the plan has no task of its own to carry it. */
  readonly planner?: string
  /** Provider/model identity that produced the implementation. */
  readonly implementer?: string
  /** Provider/model identity that produced the accepted review. */
  readonly reviewer?: string
}

/**
 * A hold the host writes when it decides on its own that a person is needed.
 *
 * Closed on purpose: the gate that turns a hold into a question switches on
 * these, and a new reason added without a matching question silently inherits
 * the generic one. Budget circuits are deliberately not in here — they carry an
 * interpolated task id (`max_task_attempts:t1`) and are matched by prefix.
 */
export type HoldReason =
  | 'backend_failed'
  | 'parent_commit_failed'
  | 'missing_review_worktree'
  | 'review_requested_replan'
  | 'empty_task'
  | 'scope_violation'
  | 'scope_check_failed'
  | 'no_review_pass'
  | 'stale_review_sha'
  | 'unknown_review_sha'
  | 'reviewer_identity_conflict'
  | 'security_high_risk'
  | 'repeated_test_failure'
  | 'blocked_task'
  | 'merge_wedged'
  | 'unknown_base'
  | 'merge_onto_trunk'
  | 'merge_detached_head'
  | 'missing_agent_result'
  | 'invalid_agent_result'
  | 'result_transition_failed'
  // Carries which check failed, so the gate can name it. Matched by prefix,
  // the same way the budget circuits' interpolated reasons are.
  | `acceptance_failed:${string}`
  // The pre-PR checker: over the PR budget (split it), other blocking rules, or no verdict.
  | `task_over_budget:${string}`
  | `prepr_blocked:${string}`
  | `prepr_unavailable:${string}`

/**
 * Reasons a budget circuit trips. Closed for the same reason `HoldReason` is:
 * the gate switches on these, and one added without a question there would
 * reach an operator as "the loop stopped and needs a decision".
 */
export type CircuitReason =
  | 'daily_cost_cap'
  | 'session_cost_cap'
  | 'max_tokens_per_task'
  | 'no_progress'
  | `task_timeout:${string}`
  | `dispatch_refused:${string}`
  | `max_task_attempts:${string}`
  | `max_review_cycles:${string}`
  | `duplicate_action:${string}`

/** A reason with its interpolated tail removed, as the gate matches it. */
export type BaseReason<R extends string> = R extends `${infer B}:${string}` ? B : R

export interface SupervisorHold {
  readonly taskId: string | null
  readonly reason: string
}

/**
 * An operator's decision to leave a halt alone.
 *
 * `answer stop` changes no task and lifts no hold, so without this the state
 * directory cannot tell "nobody has looked at this yet" from "somebody looked
 * and chose not to act". It is recorded as an ordinary revision rather than an
 * annotation on an existing one, because the journal's recovery check requires
 * every event to advance the revision by exactly one.
 */
export interface Acknowledgement {
  readonly at: string
  readonly reason: string
  readonly taskId: string | null
}

/**
 * An operator's decision to stop a loop that had nothing wrong with it.
 *
 * Every other halt is the loop's own: a circuit tripped, a hold was raised, and
 * the gate turns that into a question. A pause has no question — the answer is
 * simply to resume — so it is recorded as what it is rather than borrowing a
 * hold reason, and `killSwitch` is set beside it so every existing halted path
 * (tick short-circuit, stale-result refusal, `stop` decision) applies unchanged.
 */
export interface Pause {
  readonly at: string
  /** Which surface did it: the audit trail for a loop paused from another device. */
  readonly via: 'cli' | 'dashboard'
}

export interface BudgetUsage {
  readonly taskAttempts: Readonly<Record<string, number>>
  /**
   * Dispatches a provider refused outright, counted for the task's lifetime.
   *
   * Deliberately not refunded: `taskAttempts` is what a run is allowed to
   * spend, and handing it back is the point of a refund. This is the record
   * that the loop kept trying, which is what stops a misconfiguration from
   * retrying until a generic no-progress timer notices.
   */
  readonly refusedDispatches: Readonly<Record<string, number>>
  readonly reviewCycles: Readonly<Record<string, number>>
  readonly taskStartedAt: Readonly<Record<string, number>>
  readonly tokens: Readonly<Record<string, number>>
  readonly costUsdSession: number
  readonly costUsdDay: number
  readonly lastActions: readonly string[]
  readonly lastProgressAt: number
  readonly parallelWorkers: number
}

export type LoopAction =
  | { readonly type: 'stop'; readonly reason: 'goal_complete' | 'budget' | 'blocked' | 'kill_switch' }
  | { readonly type: 'plan' }
  | { readonly type: 'delegate'; readonly taskId: string }
  | { readonly type: 'review'; readonly taskId: string }
  | { readonly type: 'merge'; readonly taskId: string }
  | { readonly type: 'escalate'; readonly taskId: string | null; readonly reason: string }
  | { readonly type: 'idle' }

export interface LoopState {
  readonly version: 1
  /** Monotonic host revision; models never choose this value. */
  readonly revision: number
  readonly goalCompleted: boolean
  readonly killSwitch: boolean
  readonly supervisor: SupervisorHold | null
  readonly tasks: readonly Task[]
  readonly usage: BudgetUsage
  readonly lastAction: LoopAction
  readonly lastDispatchStatus?: string | null
  /** Set by `answer stop`; cleared the moment the hold is actually lifted. */
  readonly acknowledged?: Acknowledgement
  /** Set by `devloop pause` or the dashboard; cleared by resume. */
  readonly paused?: Pause
  /**
   * The branch the loop works on, as it was at the first delegate: what task
   * pull requests target and what the release pull request brings to trunk.
   * Absent until then, and on a loop that was started detached or on a trunk.
   */
  readonly workBranch?: string
  readonly updatedAt: string
}

export interface TaskContract {
  readonly taskId: string
  readonly title: string
  readonly tier: ModelTier
  readonly allowedPaths: readonly string[]
  readonly forbidden: readonly string[]
  readonly acceptance: readonly string[]
  readonly budget: {
    readonly maxMinutes: number
    readonly maxAttempts: number
  }
  /** Git SHA of the task branch at delegate time. Merge refuses if HEAD of the branch is still this. */
  readonly baseSha?: string
  /** Exact implementation commit to inspect during review. */
  readonly implementationSha?: string
  /** That commit's size, when it is over the PR budget but inside the elastic band. */
  readonly overBudget?: string
}

export interface Route {
  readonly tier: ModelTier
  readonly backend: string
  readonly model: string
}

export const STATE_VERSION = 1 as const
