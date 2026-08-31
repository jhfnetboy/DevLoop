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
  /** Provider/model identity that produced the implementation. */
  readonly implementer?: string
  /** Provider/model identity that produced the accepted review. */
  readonly reviewer?: string
}

export interface SupervisorHold {
  readonly taskId: string | null
  readonly reason: string
}

export interface BudgetUsage {
  readonly taskAttempts: Readonly<Record<string, number>>
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
}

export interface Route {
  readonly tier: ModelTier
  readonly backend: string
  readonly model: string
}

export const STATE_VERSION = 1 as const
