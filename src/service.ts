import { clearInterval, setInterval } from 'node:timers'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  NoopBackend,
  dispatchTick,
  runInputFor,
  type AgentBackend,
} from './backend.js'
import { ConfigSchema, resolveConfig, type Config } from './config.js'
import { loadState, saveState, withStateLock, workspaceArmed } from './persist.js'
import { runTick, type TickResult } from './tick.js'
import { prepareDelegateWorktree } from './worktree.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    devloop: DevloopService
  }
}

/**
 * Host service: a process-local timer drives one deterministic tick against
 * `<root>/.devloop/`. After STATE is written, plan/delegate/review is handed to
 * `AgentBackend` outside the lock. Delegate also creates a git worktree and
 * writes CONTRACT.json. 0.2.2 still does not spawn workers.
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
        const result = runTick(current, this.config.budget, now)
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
      if (this.disposed) return
      if (outcome.value && !outcome.value.result.skipped) {
        await dispatchTick(
          this.backend,
          this.config.root,
          outcome.value.result.action,
          outcome.value.result.state,
          this.config.budget,
          this.ctx.logger,
          outcome.value.worktreeRoot,
        )
      }
    } catch (error) {
      this.ctx.logger.error('[dsh-devloop] tick failed', error)
    } finally {
      this.busy = false
    }
  }

  /**
   * Cordis constructs `(ctx, config)` only. 0.2.3 overrides this to return a
   * DSH headless backend without changing the constructor signature.
   */
  protected createBackend(): AgentBackend {
    return new NoopBackend()
  }
}
