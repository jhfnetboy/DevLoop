import type { BudgetLimits, RoutingTable } from './config.js'
import { contractForTask } from './router.js'
import type { LoopAction, LoopState, Route, TaskContract } from './types.js'
import type { DevloopResult } from './result.js'

export type AgentAction = Extract<LoopAction, { type: 'plan' } | { type: 'delegate' } | { type: 'review' }>

export interface AgentRunInput {
  readonly action: AgentAction
  readonly contract: TaskContract | null
  readonly workspaceRoot: string
  readonly worktreeRoot: string | null
  /** Concrete provider/model selected by RoutedBackend. */
  readonly route?: Route
  readonly signal?: AbortSignal
}

export interface AgentRunResult {
  readonly status: 'recorded' | 'started' | 'failed'
  readonly detail?: string
  readonly tokens?: number
  readonly costUsd?: number
  /** Validated machine result. Required for autonomous state advancement. */
  readonly outcome?: DevloopResult
  /** Concrete provider/model identity used for independent-review checks. */
  readonly agent?: string
}

/**
 * Adapter boundary for DSH / Codex / Claude workers.
 * `cancel` / `health` are reserved; 0.3 production calls `run` on noop / dsh / claude / codex.
 */
export interface AgentBackend {
  run(input: AgentRunInput): Promise<AgentRunResult>
  cancel(taskId: string): Promise<void>
  health(): Promise<'ok' | 'down'>
}

export interface RoutedBackendConfig {
  readonly planner: Route
  readonly reviewer: Route
  readonly workers: RoutingTable
}

export type BackendRegistry = Readonly<Record<string, AgentBackend>>

/** Role-aware adapter mux. Unknown adapters and self-review fail closed. */
export class RoutedBackend implements AgentBackend {
  constructor(
    private readonly config: RoutedBackendConfig,
    private readonly backends: BackendRegistry,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const selected = this.routeFor(input)
    if (!selected.ok) return { status: 'failed', detail: selected.detail }
    const backend = this.backends[selected.route.backend]
      ?? (selected.route.backend.startsWith('subagent:') ? this.backends.subagent : undefined)
    if (!backend) {
      return {
        status: 'failed',
        detail: `no backend adapter registered for ${selected.route.backend}`,
      }
    }
    const result = await backend.run({ ...input, route: selected.route })
    return { ...result, agent: `${selected.route.backend}/${selected.route.model}` }
  }

  async cancel(taskId: string): Promise<void> {
    await Promise.all([...new Set(Object.values(this.backends))].map(backend => backend.cancel(taskId)))
  }

  async health(): Promise<'ok' | 'down'> {
    const statuses = await Promise.all(
      [...new Set(Object.values(this.backends))].map(backend => backend.health()),
    )
    return statuses.every(status => status === 'ok') ? 'ok' : 'down'
  }

  private routeFor(input: AgentRunInput): { ok: true; route: Route } | { ok: false; detail: string } {
    if (input.action.type === 'plan') return { ok: true, route: this.config.planner }
    if (!input.contract) return { ok: false, detail: 'cannot route action without a task contract' }
    if (input.action.type === 'delegate') {
      return { ok: true, route: this.config.workers[input.contract.tier] }
    }
    const implementer = this.config.workers[input.contract.tier]
    const reviewer = this.config.reviewer
    if (sameAgentRoute(implementer, reviewer)) {
      return {
        ok: false,
        detail: `review route must differ from implementer route ${implementer.backend}/${implementer.model}`,
      }
    }
    return { ok: true, route: reviewer }
  }
}

function sameAgentRoute(left: Route, right: Route): boolean {
  if (left.backend.startsWith('subagent:') && left.backend === right.backend) return true
  return left.backend === right.backend && left.model === right.model
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
    return { action, contract: null, workspaceRoot, worktreeRoot: null }
  }
  const task = state.tasks.find(item => item.id === action.taskId)
  if (!task) {
    return { action, contract: null, workspaceRoot, worktreeRoot: null }
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
      task.baseSha,
      task.implementationSha,
    ),
    workspaceRoot,
    worktreeRoot: null,
  }
}

export interface DispatchLog {
  error(message: string, ...rest: unknown[]): void
}

/**
 * Hand a persisted tick to the adapter. At-most-once applies only after STATE
 * is latched: a throw or `failed` is logged and not retried.
 * Worktree prepare happens earlier, inside the lock, and is not latched on failure.
 */
export async function dispatchTick(
  backend: AgentBackend,
  workspaceRoot: string,
  action: LoopAction,
  state: LoopState,
  limits: BudgetLimits,
  log: DispatchLog,
  worktreeRoot: string | null = null,
  signal?: AbortSignal,
): Promise<AgentRunResult | undefined> {
  if (!isAgentAction(action)) return
  const input = runInputFor(workspaceRoot, action, state, limits)
  if (action.type !== 'plan' && !input.contract) {
    log.error(`[dsh-devloop] skip backend: missing task ${action.taskId}`)
    return
  }
  try {
    const dispatched = await backend.run({ ...input, worktreeRoot, signal })
    if (dispatched.status === 'failed') {
      log.error(`[dsh-devloop] backend failed: ${dispatched.detail ?? 'unknown'}`)
    }
    return dispatched
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
