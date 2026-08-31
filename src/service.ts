import { constants, lstat, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { clearInterval, setInterval } from 'node:timers'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  NoopBackend,
  RoutedBackend,
  dispatchTick,
  isAgentAction,
  runInputFor,
  type AgentBackend,
} from './backend.js'
import { ConfigSchema, resolveConfig, type Config } from './config.js'
import { ClaudeCliBackend, CodexCliBackend } from './cli.js'
import { DshHeadlessBackend } from './dsh.js'
import { DEVLOOP_DIR, loadState, saveState, withStateLock, workspaceArmed, type LockResult } from './persist.js'
import { writeProgress } from './progress.js'
import { applyRunSignals, rollCostWindows } from './budget.js'
import { runTick, type TickResult } from './tick.js'
import type { LoopState } from './types.js'
import { RUNNER_REAP_MS } from './spawn.js'
import { prepareDelegateWorktree, preparePlanWorktree, removePlanWorktree, mergeTaskWorktree, deleteMergedTaskBranch, worktreePath, worktreeTaskToken, readContractBaseSha, commitDirtyTaskWorktree } from './worktree.js'

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
  private sessionCostReset = false
  private disposed = false
  private dispatchAbort: AbortController | null = null
  private pendingCommitHold: string | null = null
  private pendingSignals: { taskId: string | null; tokens?: number; costUsd?: number } | null = null

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
        let current = await loadState(this.config.root, now)
        this.pendingCommitHold = this.pendingCommitHold ?? await readCommitHoldMarker(this.config.root)
        if (this.pendingCommitHold && !current.killSwitch && !current.supervisor) {
          current = holdTask(current, this.pendingCommitHold, 'parent_commit_failed')
          await saveState(this.config.root, current)
          this.pendingCommitHold = null
          await clearCommitHoldMarker(this.config.root)
        }
        let sessionRolled = false
        let pendingApplied = false
        if (this.pendingSignals && !current.killSwitch && !current.supervisor) {
          current = {
            ...current,
            usage: applyRunSignals(current.usage, this.pendingSignals.taskId, now, this.pendingSignals),
          }
          pendingApplied = true
        }
        if (!this.sessionCostReset && !current.killSwitch && current.usage.costUsdSession !== 0) {
          current = {
            ...current,
            usage: rollCostWindows(current.usage, now, true),
          }
          sessionRolled = true
        }
        if (current.supervisor?.reason === 'unreadable_state') {
          this.ctx.logger.error('[dsh-devloop] tick skipped: unreadable STATE.json')
          await snapshotProgress(this.config.root, current, now, this.ctx.logger)
          return
        }
        if (current.killSwitch || current.lastAction.type === 'stop') {
          await snapshotProgress(this.config.root, current, now, this.ctx.logger)
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
          try {
            await saveState(this.config.root, result.state)
            if (pendingApplied) this.pendingSignals = null
            this.sessionCostReset = true
            this.ctx.logger.info(`[dsh-devloop] tick action=${result.action.type}`)
          } catch (error) {
            if (worktreeRoot && result.action.type === 'plan' && isolatedPlan(this.config.agentBackend)) {
              try {
                await removePlanWorktree(this.config.root)
              } catch (cleanupError) {
                this.ctx.logger.error('[dsh-devloop] plan worktree cleanup failed', cleanupError)
              }
              worktreeRoot = null
            }
            throw error
          }
        } else if (sessionRolled) {
          await saveState(this.config.root, result.state)
          if (pendingApplied) this.pendingSignals = null
          this.sessionCostReset = true
        } else {
          const rolled = rollCostWindows(result.state.usage, now)
          const dayRolled = rolled.costUsdDay !== result.state.usage.costUsdDay
          if (dayRolled || pendingApplied) {
            result = {
              ...result,
              state: { ...result.state, usage: pendingApplied ? rollCostWindows(result.state.usage, now) : rolled },
            }
            await saveState(this.config.root, result.state)
            if (pendingApplied) this.pendingSignals = null
          }
          this.sessionCostReset = true
        }
        await snapshotProgress(this.config.root, result.state, now, this.ctx.logger)
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
            const dispatched = await awaitDispatch(
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
            if (
              dispatched?.status === 'started'
              && action.type === 'delegate'
              && outcome.value.worktreeRoot
            ) {
              try {
                await commitDirtyTaskWorktree(outcome.value.worktreeRoot, action.taskId)
              } catch (error) {
                this.ctx.logger.error('[dsh-devloop] parent commit failed', error)
                const held = await persistParentCommitHold(this.config.root, action.taskId, this.ctx.logger)
                if (!held) {
                  this.pendingCommitHold = action.taskId
                  await writeCommitHoldMarker(this.config.root, action.taskId, this.ctx.logger)
                }
              }
            }
            const hasSignals = dispatched
              && (finitePositive(dispatched.tokens) || finitePositive(dispatched.costUsd))
            if (hasSignals && dispatched && !this.disposed) {
              const taskId = action.type === 'delegate' || action.type === 'review' ? action.taskId : null
              try {
                const folded = await persistCostSignals(this.config.root, taskId, dispatched, this.ctx.logger)
                if (folded.ok) {
                  this.pendingSignals = null
                } else {
                  this.pendingSignals = {
                    taskId,
                    tokens: dispatched.tokens,
                    costUsd: dispatched.costUsd,
                  }
                  this.ctx.logger.info('[dsh-devloop] cost signals deferred: lock held')
                }
              } catch (error) {
                this.pendingSignals = {
                  taskId,
                  tokens: dispatched.tokens,
                  costUsd: dispatched.costUsd,
                }
                this.ctx.logger.error('[dsh-devloop] cost signal persist failed', error)
              }
            }
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
    if (this.config.agentBackend === 'routed') {
      return new RoutedBackend({
        planner: this.config.plannerRoute,
        reviewer: this.config.reviewerRoute,
        workers: this.config.routing,
      }, {
        dsh: new DshHeadlessBackend(),
        claude: new ClaudeCliBackend(),
        codex: new CodexCliBackend(),
      })
    }
    if (this.config.agentBackend === 'dsh') return new DshHeadlessBackend()
    if (this.config.agentBackend === 'claude') return new ClaudeCliBackend()
    if (this.config.agentBackend === 'codex') return new CodexCliBackend()
    return new NoopBackend()
  }
}

function isolatedPlan(agentBackend: Config['agentBackend']): boolean {
  return agentBackend === 'routed' || agentBackend === 'claude' || agentBackend === 'codex'
}

const SYNTHETIC_STATE_HALTS = new Set(['unreadable_state', 'invalid_state', 'escaped_devloop'])

async function snapshotProgress(
  root: string,
  state: LoopState,
  now: number,
  log: { error(message: string, ...rest: unknown[]): void },
): Promise<void> {
  const reason = state.supervisor?.reason
  if (reason && SYNTHETIC_STATE_HALTS.has(reason)) {
    log.error(`[dsh-devloop] PROGRESS.md skipped: ${reason}`)
    return
  }
  try {
    await writeProgress(root, state, now)
  } catch (error) {
    log.error('[dsh-devloop] PROGRESS.md write failed', error)
  }
}

async function persistCostSignals(
  root: string,
  taskId: string | null,
  dispatched: { tokens?: number; costUsd?: number },
  log: { error(message: string, ...rest: unknown[]): void; info(message: string, ...rest: unknown[]): void },
): Promise<LockResult<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const folded = await withStateLock(root, async () => {
        const current = await loadState(root, Date.now())
        if (current.killSwitch || current.supervisor) return
        const next = {
          ...current,
          usage: applyRunSignals(current.usage, taskId, Date.now(), dispatched),
        }
        await saveState(root, next)
        await snapshotProgress(root, next, Date.now(), log)
      })
      if (folded.ok) return folded
    } catch {
      // Treat write/lock IO failures like contention so the caller can defer.
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 50))
  }
  return { ok: false }
}

const DISPATCH_REAP_GRACE_MS = RUNNER_REAP_MS + 250

/**
 * Prefer waiting until the backend promise settles (child reaped). If the
 * abort signal fires and the backend ignores it, cap the wait so `busy`
 * cannot stick forever.
 */
async function awaitDispatch<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let value: T | undefined
  let failure: unknown
  const settled = work.then(
    result => {
      value = result
    },
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
  let grace: ReturnType<typeof setTimeout> | undefined
  const raced = await Promise.race([
    settled.then(() => 'settled' as const),
    new Promise<'grace'>(resolve => {
      grace = setTimeout(() => resolve('grace'), DISPATCH_REAP_GRACE_MS)
    }),
  ])
  if (grace) clearTimeout(grace)
  if (raced === 'grace') throw new Error('backend timeout')
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error(String(failure))
  }
  return value
}

const COMMIT_HOLD_FILE = 'COMMIT_HOLD'

function commitHoldPath(root: string): string {
  return join(root, DEVLOOP_DIR, COMMIT_HOLD_FILE)
}

async function writeCommitHoldMarker(
  root: string,
  taskId: string,
  log: { error(message: string, ...rest: unknown[]): void },
): Promise<void> {
  const file = commitHoldPath(root)
  const temp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    const handle = await open(temp, flags, 0o600)
    try {
      await handle.writeFile(`${taskId}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    log.error('[dsh-devloop] parent commit hold marker write failed', error)
  }
}

async function readCommitHoldMarker(root: string): Promise<string | null> {
  let handle
  try {
    handle = await open(commitHoldPath(root), constants.O_RDONLY | constants.O_NOFOLLOW)
    const meta = await handle.stat()
    if (!meta.isFile()) return null
    const raw = (await handle.readFile('utf8')).trim()
    return worktreeTaskToken(raw) ? raw : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function clearCommitHoldMarker(root: string): Promise<void> {
  try {
    await unlink(commitHoldPath(root))
  } catch {
    // Missing marker is fine.
  }
}

async function persistParentCommitHold(
  root: string,
  taskId: string,
  log: { error(message: string, ...rest: unknown[]): void },
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const folded = await withStateLock(root, async () => {
        const current = await loadState(root, Date.now())
        if (current.killSwitch || current.supervisor) return
        await saveState(root, holdTask(current, taskId, 'parent_commit_failed'))
      })
      if (folded.ok) return true
    } catch (error) {
      log.error('[dsh-devloop] parent commit hold failed', error)
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 50))
  }
  log.error('[dsh-devloop] parent commit hold deferred: lock held')
  return false
}

function finitePositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
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
