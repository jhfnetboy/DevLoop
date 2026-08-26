import { clearInterval, setInterval } from 'node:timers'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  RecordingBackend,
  isAgentAction,
  runInputFor,
  type AgentBackend,
} from './backend.js'
import { ConfigSchema, resolveConfig, type Config } from './config.js'
import { loadState, saveState, withStateLock, workspaceArmed } from './persist.js'
import { runTick, type TickResult } from './tick.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    devloop: DevloopService
  }
}

/**
 * Host service: a process-local timer drives one deterministic tick against
 * `<root>/.devloop/`. After STATE is written, plan/delegate/review is handed to
 * `AgentBackend` outside the lock. 0.2.1 records only; it does not spawn workers.
 */
export default class DevloopService extends Service {
  static inject = []
  static Config = ConfigSchema
  static readonly provide = 'devloop'

  private readonly config: Config
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private disposed = false

  constructor(
    ctx: Context,
    rawConfig: Config,
    private readonly backend: AgentBackend = new RecordingBackend(),
  ) {
    super(ctx, 'devloop')
    this.config = resolveConfig(rawConfig)
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
      const outcome = await withStateLock(this.config.root, async (): Promise<TickResult | undefined> => {
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
        if (!result.skipped) {
          await saveState(this.config.root, result.state)
          this.ctx.logger.info(`[dsh-devloop] tick action=${result.action.type}`)
        }
        if (result.action.type === 'stop' || result.state.killSwitch) {
          this.stop()
        }
        return result
      })
      if (!outcome.ok) {
        this.ctx.logger.info('[dsh-devloop] tick skipped: lock held')
        return
      }
      if (outcome.value && !outcome.value.skipped) {
        await this.dispatch(outcome.value)
      }
    } catch (error) {
      this.ctx.logger.error('[dsh-devloop] tick failed', error)
    } finally {
      this.busy = false
    }
  }

  private async dispatch(result: TickResult): Promise<void> {
    if (this.disposed || !isAgentAction(result.action)) return
    const input = runInputFor(this.config.root, result.action, result.state, this.config.budget)
    if (result.action.type !== 'plan' && !input.contract) {
      this.ctx.logger.error(`[dsh-devloop] skip backend: missing task ${result.action.taskId}`)
      return
    }
    const dispatched = await this.backend.run(input)
    if (dispatched.status === 'failed') {
      this.ctx.logger.error(`[dsh-devloop] backend failed: ${dispatched.detail ?? 'unknown'}`)
    }
  }
}
