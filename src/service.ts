import { clearInterval, setInterval } from 'node:timers'
import { Service, type Context } from '@deepseek-ai/cordis'
import { ConfigSchema, resolveConfig, type Config } from './config.js'
import { loadState, saveState, withStateLock, workspaceArmed } from './persist.js'
import { runTick } from './tick.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    devloop: DevloopService
  }
}

/**
 * Host service: a process-local timer drives one deterministic tick against
 * `<root>/.devloop/`. 0.1 records the next action; it does not spawn workers.
 */
export default class DevloopService extends Service {
  static inject = []
  static Config = ConfigSchema
  static readonly provide = 'devloop'

  private readonly config: Config
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private disposed = false

  constructor(ctx: Context, rawConfig: Config) {
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
      const outcome = await withStateLock(this.config.root, async () => {
        if (this.disposed) return
        const current = await loadState(this.config.root, now)
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
      })
      if (outcome === 'locked') {
        this.ctx.logger.info('[dsh-devloop] tick skipped: lock held')
      }
    } catch (error) {
      this.ctx.logger.error('[dsh-devloop] tick failed', error)
    } finally {
      this.busy = false
    }
  }
}
