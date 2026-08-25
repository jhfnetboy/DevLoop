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
}

export interface SupervisorHold {
  readonly taskId: string | null
  readonly reason: string
}

export interface BudgetUsage {
  readonly taskAttempts: Readonly<Record<string, number>>
  readonly reviewCycles: Readonly<Record<string, number>>
  readonly taskStartedAt: Readonly<Record<string, number>>
  readonly tokens: number
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
  readonly goalCompleted: boolean
  readonly killSwitch: boolean
  readonly supervisor: SupervisorHold | null
  readonly tasks: readonly Task[]
  readonly usage: BudgetUsage
  readonly lastAction: LoopAction
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
}

export interface Route {
  readonly tier: ModelTier
  readonly backend: string
  readonly model: string
}

export const STATE_VERSION = 1 as const
