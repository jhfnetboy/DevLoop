import type { BudgetLimits } from './config.js'
import { contractForTask } from './router.js'
import type { LoopAction, LoopState, TaskContract } from './types.js'

export type AgentAction = Extract<LoopAction, { type: 'plan' } | { type: 'delegate' } | { type: 'review' }>

export interface AgentRunInput {
  readonly action: AgentAction
  readonly contract: TaskContract | null
  readonly workspaceRoot: string
}

export interface AgentRunResult {
  readonly status: 'recorded' | 'started' | 'failed'
  readonly detail?: string
}

/**
 * Adapter boundary for later DSH / Codex / Claude workers.
 * 0.2.1 only records the intended run; it does not spawn a process.
 */
export interface AgentBackend {
  run(input: AgentRunInput): Promise<AgentRunResult>
  cancel(taskId: string): Promise<void>
  health(): Promise<'ok' | 'down'>
}

export function isAgentAction(action: LoopAction): action is AgentAction {
  return action.type === 'plan' || action.type === 'delegate' || action.type === 'review'
}

export function runInputFor(
  workspaceRoot: string,
  action: AgentAction,
  state: LoopState,
  limits: BudgetLimits,
): AgentRunInput {
  if (action.type === 'plan') {
    return { action, contract: null, workspaceRoot }
  }
  const task = state.tasks.find(item => item.id === action.taskId)
  if (!task) {
    return { action, contract: null, workspaceRoot }
  }
  return {
    action,
    contract: contractForTask(
      task.id,
      task.title,
      task.tier,
      task.allowedPaths,
      task.acceptance,
      limits.taskTimeoutMinutes,
      limits.maxTaskAttempts,
    ),
    workspaceRoot,
  }
}

export interface DispatchLog {
  error(message: string, ...rest: unknown[]): void
}

/**
 * Hand a persisted tick to the adapter. At-most-once: STATE is already latched,
 * so a throw or `failed` is logged and not retried.
 */
export async function dispatchTick(
  backend: AgentBackend,
  workspaceRoot: string,
  action: LoopAction,
  state: LoopState,
  limits: BudgetLimits,
  log: DispatchLog,
): Promise<void> {
  if (!isAgentAction(action)) return
  const input = runInputFor(workspaceRoot, action, state, limits)
  if (action.type !== 'plan' && !input.contract) {
    log.error(`[dsh-devloop] skip backend: missing task ${action.taskId}`)
    return
  }
  try {
    const dispatched = await backend.run(input)
    if (dispatched.status === 'failed') {
      log.error(`[dsh-devloop] backend failed: ${dispatched.detail ?? 'unknown'}`)
    }
  } catch (error) {
    log.error('[dsh-devloop] backend threw', error)
  }
}

/** Production default: no process, no retained history. */
export class NoopBackend implements AgentBackend {
  async run(_input: AgentRunInput): Promise<AgentRunResult> {
    return { status: 'recorded' }
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    return 'ok'
  }
}

/** Test double that keeps every call. Do not use as the DSH plugin default. */
export class RecordingBackend implements AgentBackend {
  readonly runs: AgentRunInput[] = []
  readonly cancelled: string[] = []

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(input)
    return { status: 'recorded' }
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.push(taskId)
  }

  async health(): Promise<'ok' | 'down'> {
    return 'ok'
  }
}
