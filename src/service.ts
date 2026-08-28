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
import { DshHeadlessBackend } from './dsh.js'
import { loadState, saveState, withStateLock, workspaceArmed } from './persist.js'
import { runTick, type TickResult } from './tick.js'
import type { LoopState } from './types.js'
import { prepareDelegateWorktree, mergeTaskWorktree, deleteMergedTaskBranch, worktreePath } from './worktree.js'

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
 * one-shot headless.
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
            } catch (error) {
              this.ctx.logger.error('[dsh-devloop] worktree failed', error)
              return
            }
          }
        } else if (!result.skipped && result.action.type === 'review') {
          worktreeRoot = await existingWorktreeRoot(this.config.root, result.action.taskId)
        } else if (!result.skipped && result.action.type === 'merge') {
          try {
            await mergeTaskWorktree(this.config.root, result.action.taskId)
            result = {
              ...result,
              state: markTaskDone(result.state, result.action.taskId),
            }
          } catch (error) {
            this.ctx.logger.error('[dsh-devloop] merge failed', error)
            return
          }
        }
        if (!result.skipped) {
          await saveState(this.config.root, result.state)
          this.ctx.logger.info(`[dsh-devloop] tick action=${result.action.type}`)
          if (result.action.type === 'merge') {
            try {
              await deleteMergedTaskBranch(this.config.root, result.action.taskId)
            } catch (error) {
              this.ctx.logger.error('[dsh-devloop] task branch cleanup failed', error)
            }
          }
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
      if (this.disposed) return
      if (outcome.value && !outcome.value.result.skipped && isAgentAction(outcome.value.result.action)) {
        const abort = new AbortController()
        this.dispatchAbort = abort
        const timeoutMs = this.config.budget.taskTimeoutMinutes * 60_000
        const timer = setTimeout(() => abort.abort(), timeoutMs)
        try {
          await raceAbort(
            dispatchTick(
              this.backend,
              this.config.root,
              outcome.value.result.action,
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
            this.ctx.logger.error('[dsh-devloop] backend timed out', error)
          }
        } finally {
          clearTimeout(timer)
          if (this.dispatchAbort === abort) this.dispatchAbort = null
        }
      }
    } catch (error) {
      this.ctx.logger.error('[dsh-devloop] tick failed', error)
    } finally {
      this.busy = false
    }
  }

  /**
   * Cordis constructs `(ctx, config)` only. `agentBackend: 'dsh'` returns
   * DshHeadlessBackend; the default stays NoopBackend so tests without the
   * third constructor arg do not spawn.
   */
  protected createBackend(): AgentBackend {
    if (this.config.agentBackend === 'dsh') return new DshHeadlessBackend()
    return new NoopBackend()
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('backend timeout'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('backend timeout'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
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
