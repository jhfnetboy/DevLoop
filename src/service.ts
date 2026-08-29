import { lstat } from 'node:fs/promises'
import { clearInterval, setInterval } from 'node:timers'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  NoopBackend,
  dispatchTick,
  isAgentAction,
  runInputFor,
  type AgentBackend,
} from './backend.js'
import { ConfigSchema, resolveConfig, type Config } from './config.js'
import { ClaudeCliBackend, CodexCliBackend } from './cli.js'
import { DshHeadlessBackend } from './dsh.js'
import { loadState, saveState, withStateLock, workspaceArmed } from './persist.js'
import { runTick, type TickResult } from './tick.js'
import type { LoopState } from './types.js'
import { SIGKILL_GRACE_MS } from './spawn.js'
import { prepareDelegateWorktree, preparePlanWorktree, removePlanWorktree, mergeTaskWorktree, deleteMergedTaskBranch, worktreePath, readContractBaseSha } from './worktree.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    devloop: DevloopService
  }
}

/**
 * Host service: a process-local timer drives one deterministic tick against
 * `<root>/.devloop/`. After STATE is written, plan/delegate/review is handed to
 * `AgentBackend` outside the lock. Delegate also creates a git worktree and
 * writes CONTRACT.json. Merge (0.2.4) git-merges the task branch after
 * Review PASS, then deletes the worktree. Set `agentBackend: 'dsh'` to spawn
 * one-shot headless, or `claude` / `codex` for T3 CLIs. Default stays noop.
 */
export default class DevloopService extends Service {
  static inject = []
  static Config = ConfigSchema
  static readonly provide = 'devloop'

  private readonly config: Config
  readonly backend: AgentBackend
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private disposed = false
  private dispatchAbort: AbortController | null = null

  constructor(ctx: Context, rawConfig: Config, backend?: AgentBackend) {
    super(ctx, 'devloop')
    this.config = resolveConfig(rawConfig)
    this.backend = backend ?? this.createBackend()
    if (!this.config.enabled) {
      ctx.logger.info('[dsh-devloop] disabled by config')
      return
    }
    ctx.logger.info(`[dsh-devloop] loaded root=${this.config.root}`)
    ctx.effect(() => {
      this.start()
      return () => this.stop()
    })
  }

  start(): void {
    if (this.timer || this.disposed) return
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.config.tickIntervalMs)
  }

  stop(): void {
    this.disposed = true
    this.dispatchAbort?.abort()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.disposed || this.busy) return
    this.busy = true
    try {
      if (this.disposed) return
      if (!await workspaceArmed(this.config.root)) return
      const outcome = await withStateLock(this.config.root, async (): Promise<{
        result: TickResult
        worktreeRoot: string | null
      } | undefined> => {
        if (this.disposed) return
        const current = await loadState(this.config.root, now)
        if (current.supervisor?.reason === 'unreadable_state') {
          this.ctx.logger.error('[dsh-devloop] tick skipped: unreadable STATE.json')
          return
        }
        if (current.killSwitch || current.lastAction.type === 'stop') {
          this.stop()
          return
        }
        let result = runTick(current, this.config.budget, now)
        if (this.disposed) return
        let worktreeRoot: string | null = null
        if (!result.skipped && result.action.type === 'delegate') {
          const input = runInputFor(this.config.root, result.action, result.state, this.config.budget)
          if (input.contract) {
            try {
              worktreeRoot = await prepareDelegateWorktree(this.config.root, input.contract)
              const baseSha = await readContractBaseSha(worktreeRoot)
              if (baseSha) {
                result = {
                  ...result,
                  state: stampTaskBaseSha(result.state, result.action.taskId, baseSha),
                }
              }
            } catch (error) {
              this.ctx.logger.error('[dsh-devloop] worktree failed', error)
              return
            }
          }
        } else if (!result.skipped && result.action.type === 'plan' && isolatedPlan(this.config.agentBackend)) {
          try {
            worktreeRoot = await preparePlanWorktree(this.config.root)
          } catch (error) {
            this.ctx.logger.error('[dsh-devloop] plan worktree failed', error)
            return
          }
        } else if (!result.skipped && result.action.type === 'review') {
          worktreeRoot = await existingWorktreeRoot(this.config.root, result.action.taskId)
        } else if (!result.skipped && result.action.type === 'merge') {
          const mergeTaskId = result.action.taskId
          try {
            await mergeTaskWorktree(
              this.config.root,
              mergeTaskId,
              result.state.tasks.find(task => task.id === mergeTaskId)?.baseSha ?? null,
            )
            result = {
              ...result,
              state: markTaskDone(result.state, mergeTaskId),
            }
          } catch (error) {
            this.ctx.logger.error('[dsh-devloop] merge failed', error)
            const reason = mergeHoldReason(error)
            if (reason) {
              result = {
                ...result,
                action: { type: 'escalate', taskId: mergeTaskId, reason },
                state: holdTask(result.state, mergeTaskId, reason),
              }
            }
          }
        }
        if (!result.skipped) {
          await saveState(this.config.root, result.state)
          this.ctx.logger.info(`[dsh-devloop] tick action=${result.action.type}`)
        }
        if (result.action.type === 'stop' || result.state.killSwitch) {
          this.stop()
        }
        return { result, worktreeRoot }
      })
      if (!outcome.ok) {
        this.ctx.logger.info('[dsh-devloop] tick skipped: lock held')
        return
      }
      const tick = outcome.value?.result
      const mergeAction = tick?.action
      const mergedTaskId = mergeAction?.type === 'merge'
        && tick?.state.tasks.some(task => task.id === mergeAction.taskId && task.status === 'done')
        ? mergeAction.taskId
        : null
      if (mergedTaskId) {
        try {
          await deleteMergedTaskBranch(this.config.root, mergedTaskId)
        } catch (error) {
          this.ctx.logger.error('[dsh-devloop] task branch cleanup failed', error)
        }
      }
      const preparedPlan = isolatedPlan(this.config.agentBackend)
        && outcome.value?.result.action.type === 'plan'
        && outcome.value.worktreeRoot !== null
      try {
        if (this.disposed) return
        if (outcome.value && !outcome.value.result.skipped && isAgentAction(outcome.value.result.action)) {
          const abort = new AbortController()
          this.dispatchAbort = abort
          const timeoutMs = this.config.budget.taskTimeoutMinutes * 60_000
          const timer = setTimeout(() => abort.abort(), timeoutMs)
          const action = outcome.value.result.action
          try {
            await awaitDispatch(
              dispatchTick(
                this.backend,
                this.config.root,
                action,
                outcome.value.result.state,
                this.config.budget,
                this.ctx.logger,
                outcome.value.worktreeRoot,
                abort.signal,
              ),
              abort.signal,
            )
          } catch (error) {
            if (!this.disposed) {
              const timeout = error instanceof Error && error.message === 'backend timeout'
              this.ctx.logger.error(timeout ? '[dsh-devloop] backend timed out' : '[dsh-devloop] backend failed', error)
            }
          } finally {
            clearTimeout(timer)
            if (this.dispatchAbort === abort) this.dispatchAbort = null
          }
        }
      } finally {
        if (preparedPlan) {
          try {
            await removePlanWorktree(this.config.root)
          } catch (error) {
            this.ctx.logger.error('[dsh-devloop] plan worktree cleanup failed', error)
          }
        }
      }
    } catch (error) {
      this.ctx.logger.error('[dsh-devloop] tick failed', error)
    } finally {
      this.busy = false
    }
  }

  /**
   * Cordis constructs `(ctx, config)` only. Opt-in CLIs: `dsh`, `claude`,
   * `codex`. The default stays NoopBackend so tests without the third
   * constructor arg do not spawn. RecordingBackend is tests-only.
   */
  protected createBackend(): AgentBackend {
    if (this.config.agentBackend === 'dsh') return new DshHeadlessBackend()
    if (this.config.agentBackend === 'claude') return new ClaudeCliBackend()
    if (this.config.agentBackend === 'codex') return new CodexCliBackend()
    return new NoopBackend()
  }
}

function isolatedPlan(agentBackend: Config['agentBackend']): boolean {
  return agentBackend === 'claude' || agentBackend === 'codex'
}

const DISPATCH_REAP_GRACE_MS = SIGKILL_GRACE_MS + 250

/**
 * Prefer waiting until the backend promise settles (child reaped). If the
 * abort signal fires and the backend ignores it, cap the wait so `busy`
 * cannot stick forever.
 */
async function awaitDispatch(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  let failure: unknown
  const settled = work.then(
    () => undefined,
    error => {
      failure = error
    },
  )
  if (!signal.aborted) {
    await Promise.race([
      settled,
      new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      }),
    ])
  }
  const raced = await Promise.race([
    settled.then(() => 'settled' as const),
    new Promise<'grace'>(resolve => {
      setTimeout(() => resolve('grace'), DISPATCH_REAP_GRACE_MS)
    }),
  ])
  if (raced === 'grace') throw new Error('backend timeout')
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error(String(failure))
  }
}

function mergeHoldReason(error: unknown): 'empty_task' | 'merge_wedged' | 'unknown_base' | null {
  const message = error instanceof Error ? error.message : ''
  if (message.startsWith('empty_task')) return 'empty_task'
  if (message.startsWith('merge_wedged')) return 'merge_wedged'
  if (message.startsWith('unknown_base')) return 'unknown_base'
  return null
}

function holdTask(state: LoopState, taskId: string, reason: string): LoopState {
  return {
    ...state,
    supervisor: { taskId, reason },
    lastAction: { type: 'escalate', taskId, reason },
  }
}

function stampTaskBaseSha(state: LoopState, taskId: string, baseSha: string): LoopState {
  return {
    ...state,
    tasks: state.tasks.map(task => task.id === taskId ? { ...task, baseSha } : task),
  }
}

function markTaskDone(state: LoopState, taskId: string): LoopState {
  return {
    ...state,
    tasks: state.tasks.map(task => task.id === taskId ? { ...task, status: 'done' } : task),
  }
}

async function existingWorktreeRoot(root: string, taskId: string): Promise<string | null> {
  try {
    const dest = worktreePath(root, taskId)
    const meta = await lstat(dest)
    if (meta.isSymbolicLink() || !meta.isDirectory()) return null
    return dest
  } catch {
    return null
  }
}
