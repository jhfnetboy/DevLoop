import { realpathSync } from 'node:fs'
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
  type AgentAction,
  type AgentRunResult,
} from './backend.js'
import { ConfigSchema, resolveConfig, type Config } from './config.js'
import { ClaudeCliBackend, CodexCliBackend } from './cli.js'
import { runAcceptanceChecks } from './acceptance.js'
import { blockedOnlyBySize, runPreprCheck, type PreprResult } from './prepr.js'
import { appendPrLog, checkEntry } from './prlog.js'
import { ForgePrBackend } from './forge.js'
import { DshHeadlessBackend } from './dsh.js'
import { CordisHarnessHost, HarnessSubagentBackend } from './harness.js'
import { DEVLOOP_DIR, loadState, saveState, withStateLock, workspaceArmed, writeBudgetSnapshot, type LockResult } from './persist.js'
import { writeProgress } from './progress.js'
import { applyRunSignals, refundAction, rollCostWindows } from './budget.js'
import { runTick, type TickResult } from './tick.js'
import { mountDashboard, type LoopPresence } from './dashboard.js'
import { browseRoot, dshHome, listProjects } from './projects.js'
import { currentBranch, trunkBranches } from './readiness.js'
import type { BudgetUsage, HoldReason, LoopState } from './types.js'
import { RUNNER_REAP_MS } from './spawn.js'
import { applyAgentResult } from './transition.js'
import { prepareDelegateWorktree, preparePlanWorktree, removePlanWorktree, mergeTaskWorktree, deleteMergedTaskBranch, worktreePath, worktreeTaskToken, readContractBaseSha, commitDirtyTaskWorktree, assertTaskChangesAllowed, taskWorktreeHeadSha } from './worktree.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    devloop: DevloopService
  }
}

/** The two logger methods a loop uses, so a project's lines can carry its name. */
export type LoopLogger = Pick<Context['logger'], 'info' | 'error'>

/**
 * One project's loop: a process-local timer drives one deterministic tick
 * against `<root>/.devloop/`. After STATE is written, plan/delegate/review is
 * handed to `AgentBackend` outside the lock. Delegate also creates a git
 * worktree and writes CONTRACT.json. Merge git-merges the task branch after
 * Review PASS, then deletes the worktree.
 *
 * This was the whole service while a process ran one project. It is unchanged
 * in shape; what is new is that `DevloopService` owns several of them and
 * `LoopShared` stands between them.
 */
export class ProjectLoop {
  private readonly config: Config
  private readonly ctx: { readonly logger: LoopLogger }
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private sessionCostReset = false
  private disposed = false
  private dispatchAbort: AbortController | null = null
  private pendingCommitHold: string | null = null
  private pendingSignals: { taskId: string | null; tokens?: number; costUsd?: number } | null = null
  /**
   * The revision this loop last found halted at, or null while it is running.
   *
   * A halted loop keeps its timer. It used to dispose it, which made
   * `devloop resume` need a profile restart; now each tick first peeks at
   * STATE without the lock, and while the revision is the one it already saw
   * halted it returns having written nothing. An answer, a resume or a pause
   * from any surface moves the revision, and the next tick acts on it.
   */
  private haltedRevision: number | null = null
  private budgetSnapshotWritten = false
  /** The usage this loop last read, for the day's spend summed across projects. */
  lastUsage: BudgetUsage | null = null

  constructor(
    logger: LoopLogger,
    config: Config,
    readonly backend: AgentBackend,
    private readonly shared: LoopShared = new LoopShared(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
  ) {
    this.config = config
    this.ctx = { logger }
  }

  get root(): string {
    return this.config.root
  }

  get running(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer || this.disposed) return
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.config.tickIntervalMs)
  }

  /**
   * Abandon the dispatch in flight, if any. Its result would be refused as
   * stale anyway once the loop is paused; aborting stops paying for it.
   */
  abortDispatch(): void {
    this.dispatchAbort?.abort()
  }

  /** Tick now rather than at the next interval, so a surface sees its change take effect. */
  poke(): void {
    void this.tick()
  }

  /** Dispose: only for plugin teardown. A halt no longer comes through here. */
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
    let admitted = false
    try {
      if (this.disposed) return
      if (!await workspaceArmed(this.config.root)) return
      if (!this.budgetSnapshotWritten) {
        // So `devloop status` answers with this profile's limits, not the
        // defaults. Written on the first armed tick rather than at start: an
        // unarmed root — `$HOME`, under launchd — must not grow a `.devloop/`.
        this.budgetSnapshotWritten = true
        void writeBudgetSnapshot(this.config.root, this.config.budget).catch((error: unknown) => {
          this.ctx.logger.error('[dsh-devloop] budget snapshot failed', error)
        })
      }
      if (this.haltedRevision !== null) {
        // Read-only and lock-free: STATE is replaced by rename, so a peek sees a
        // whole snapshot. Still halted at the same revision means nothing changed.
        const peek = await loadState(this.config.root, now)
        this.lastUsage = peek.usage
        if (peek.revision === this.haltedRevision && (peek.killSwitch || peek.lastAction.type === 'stop')) return
        this.haltedRevision = null
      }
      // Across projects: a slot per tick that might dispatch, and no new work
      // anywhere once the day's combined spend reaches the shared cap. Waiting,
      // not halting: a halt would need an answer, and the cause is elsewhere.
      if (!this.shared.admit(now)) return
      admitted = true
      const outcome = await withStateLock(this.config.root, async (): Promise<{
        result: TickResult
        worktreeRoot: string | null
      } | undefined> => {
        if (this.disposed) return
        let current = await loadState(this.config.root, now)
        this.lastUsage = current.usage
        this.pendingCommitHold = this.pendingCommitHold ?? await readCommitHoldMarker(this.config.root)
        if (this.pendingCommitHold && !current.killSwitch && !current.supervisor) {
          current = holdTask(current, this.pendingCommitHold, 'parent_commit_failed')
          current = await saveState(this.config.root, current, {
            expectedRevision: current.revision,
            action: 'hold:parent_commit_failed',
          })
          this.pendingCommitHold = null
          await clearCommitHoldMarker(this.config.root)
        }
        const pendingHold = await readPendingHold(this.config.root)
        if (pendingHold === 'unreadable') {
          // Kept — it may hold a real hold — but never silently: say so every tick until it reads.
          this.ctx.logger.error('[dsh-devloop] PENDING_HOLD marker unreadable; kept for the next tick')
        } else if (pendingHold === 'invalid') {
          // Corrupt, or not a plain file: say so and remove it, rather than read it every tick.
          this.ctx.logger.error('[dsh-devloop] unusable PENDING_HOLD marker removed')
          await unlink(join(this.config.root, DEVLOOP_DIR, PENDING_HOLD_FILE)).catch(() => undefined)
        } else if (pendingHold) {
          // Applied only to a running loop; one already halted is showing its own hold,
          // and a resume after it must not bring this stale one back.
          if (!current.killSwitch && !current.supervisor) {
            const { taskId, reason } = pendingHold
            current = await saveState(this.config.root, {
              ...current,
              supervisor: { taskId, reason },
              lastAction: { type: 'escalate', taskId, reason },
            }, { expectedRevision: current.revision, action: `hold:${reason}` })
          }
          await unlink(join(this.config.root, DEVLOOP_DIR, PENDING_HOLD_FILE)).catch(() => undefined)
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
          this.haltedRevision = current.revision
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
              // At the first delegate that finds it unset, and never again: the branch every later task pull request targets.
              // A trunk or a detached HEAD is left unrecorded: with the forge, the review then holds before any pull request is opened.
              if (result.state.workBranch === undefined) {
                const branch = await currentBranch(this.config.root)
                if (branch !== null && !(await trunkBranches(this.config.root)).has(branch.toLowerCase())) {
                  result = { ...result, state: { ...result.state, workBranch: branch } }
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
          const reviewTaskId = result.action.taskId
          // A task pull request needs the work branch as its base, never trunk: one an older delegate
          // did not record is recorded now, and a checkout on trunk or detached holds before any is opened.
          if (mergesOnForge(this.config) && result.state.workBranch === undefined) {
            const branch = await currentBranch(this.config.root)
            if (branch !== null && !(await trunkBranches(this.config.root)).has(branch.toLowerCase())) {
              result = { ...result, state: { ...result.state, workBranch: branch } }
            } else {
              const reason = branch === null ? 'merge_detached_head' : 'merge_onto_trunk'
              // No review ran, so the cycle the tick charged for one is given back: a resume still on trunk must hold for this again, not for max_review_cycles.
              const refunded = { ...result.state, usage: refundAction(result.state.usage, result.action) }
              result = { ...result, action: { type: 'escalate', taskId: reviewTaskId, reason }, state: holdTask(refunded, reviewTaskId, reason) }
            }
          }
          if (result.action.type === 'review') worktreeRoot = await existingWorktreeRoot(this.config.root, reviewTaskId)
        } else if (!result.skipped && result.action.type === 'merge') {
          const mergeTaskId = result.action.taskId
          try {
            await mergeTaskWorktree(
              this.config.root,
              mergeTaskId,
              result.state.tasks.find(task => task.id === mergeTaskId)?.baseSha ?? null,
              result.state.tasks.find(task => task.id === mergeTaskId)?.implementationSha ?? null,
              // The same trunks the page refuses to start on, asked again here:
              // the checkout can be switched back after the start was checked.
              { trunks: await trunkBranches(this.config.root) },
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
            result = {
              ...result,
              state: await saveState(this.config.root, result.state, {
                expectedRevision: current.revision,
                action: actionKeyForJournal(result.action),
              }),
            }
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
          result = {
            ...result,
            state: await saveState(this.config.root, result.state, {
              expectedRevision: current.revision,
              action: 'cost:session-roll',
            }),
          }
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
            result = {
              ...result,
              state: await saveState(this.config.root, result.state, {
                expectedRevision: current.revision,
                action: pendingApplied ? 'cost:deferred' : 'cost:day-roll',
              }),
            }
            if (pendingApplied) this.pendingSignals = null
          }
          this.sessionCostReset = true
        }
        await snapshotProgress(this.config.root, result.state, now, this.ctx.logger)
        if (result.action.type === 'stop' || result.state.killSwitch) {
          this.haltedRevision = result.state.revision
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
            let implementationSha: string | undefined
            let overBudget: string | undefined
            let transitionAllowed = dispatched?.status === 'started' && dispatched.outcome !== undefined
            if (transitionAllowed && action.type === 'delegate' && dispatched?.outcome?.kind === 'implementation'
              && dispatched.outcome.outcome === 'completed' && outcome.value.worktreeRoot) {
              try {
                const input = runInputFor(this.config.root, action, outcome.value.result.state, this.config.budget)
                if (!input.contract) throw new Error('scope_check: missing task contract')
                await assertTaskChangesAllowed(outcome.value.worktreeRoot, input.contract)
                await commitDirtyTaskWorktree(outcome.value.worktreeRoot, action.taskId)
                implementationSha = await taskWorktreeHeadSha(outcome.value.worktreeRoot)
                if (implementationSha === input.contract.baseSha) throw new Error('empty_task')
                // Evidence before the verdict: a task that cannot pass the
                // operator's own checks does not reach a reviewer at all.
                const failure = await runAcceptanceChecks(
                  outcome.value.worktreeRoot,
                  this.config.acceptance,
                  this.config.acceptanceTimeoutMinutes * 60_000,
                  abort.signal,
                )
                if (failure) {
                  this.ctx.logger.error(`[dsh-devloop] acceptance failed: ${failure.argv.join(' ')} — ${failure.detail}`)
                  throw new Error(`acceptance_failed: ${failure.argv.join(' ')}`)
                }
                // PR-daemon's mechanical rules, the PR size budget among them, before any
                // reviewer is paid. A checker that cannot say is a stop, never a pass.
                if (this.config.prePrCheck.length > 0) {
                  const base = input.contract.baseSha
                  const check = typeof base !== 'string' || base === ''
                    ? null
                    : await runPreprCheck(this.config.prePrCheck, this.config.prePrProfile, outcome.value.worktreeRoot, base, this.config.prePrTimeoutMinutes * 60_000)
                  // Logged whatever it said, before any hold: the budget is to be judged on these lines.
                  const estimate = outcome.value.result.state.tasks.find(task => task.id === action.taskId)?.estimate ?? null
                  if (check !== null) await appendPrLog(this.config.root, checkEntry(action.taskId, implementationSha ?? null, check, Date.now(), estimate), this.ctx.logger)
                  if (check === null || check.status === 'unavailable') throw new Error(`prepr_unavailable: ${check?.detail ?? 'the task has no base commit'}`)
                  if (check.status === 'blocked') {
                    const rules = [...new Set(check.findings.filter(f => f.severity === 'block').map(f => f.rule))].join(',')
                    if (!blockedOnlyBySize(check)) throw new Error(`prepr_blocked: ${rules}`)
                    throw new Error(`task_over_budget: ${check.size ? `${String(check.size.lines)} lines, ${String(check.size.files)} files` : rules}`)
                  }
                  // Over the budget but inside its elastic band: reviewed, with the size named.
                  if (check.band === 'elastic') overBudget = elasticSummary(check)
                }
              } catch (error) {
                transitionAllowed = false
                const reason = implementationFailureReason(error)
                // Not always the commit: by the time acceptance runs, the
                // commit has already succeeded. Log what actually refused.
                this.ctx.logger.error(`[dsh-devloop] ${reason.split(':')[0] ?? reason}`, error)
                const held = await persistAgentHold(this.config.root, action.taskId, reason, this.ctx.logger)
                if (!held) {
                  this.pendingCommitHold = action.taskId
                  await writeCommitHoldMarker(this.config.root, action.taskId, this.ctx.logger)
                }
              }
            }
            if (transitionAllowed && action.type === 'review') {
              if (!outcome.value.worktreeRoot) {
                transitionAllowed = false
                await persistAgentHold(this.config.root, action.taskId, 'missing_review_worktree', this.ctx.logger)
              } else {
                try {
                  const actualSha = await taskWorktreeHeadSha(outcome.value.worktreeRoot)
                  const expectedSha = outcome.value.result.state.tasks.find(task => task.id === action.taskId)?.implementationSha
                  if (!expectedSha || actualSha !== expectedSha) throw new Error('stale_review_sha')
                } catch (error) {
                  transitionAllowed = false
                  await persistAgentHold(this.config.root, action.taskId, 'stale_review_sha', this.ctx.logger)
                }
              }
            }
            const agentOutcome = dispatched?.outcome
            if (transitionAllowed && dispatched && agentOutcome) {
              try {
                await persistAgentTransition(
                  this.config.root,
                  action,
                  { ...dispatched, outcome: agentOutcome },
                  implementationSha === undefined ? undefined : { sha: implementationSha, ...(overBudget === undefined ? {} : { overBudget }) },
                  this.ctx.logger,
                )
                if (action.type === 'review' && agentOutcome.kind === 'review') {
                  await appendPrLog(this.config.root, {
                    kind: 'review', at: new Date().toISOString(), taskId: action.taskId,
                    head: agentOutcome.reviewedSha, verdict: agentOutcome.verdict, reviewer: dispatched.agent ?? null,
                  }, this.ctx.logger)
                }
              } catch (error) {
                this.ctx.logger.error('[dsh-devloop] result transition failed', error)
                await persistAgentHold(
                  this.config.root,
                  action.type === 'plan' ? null : action.taskId,
                  transitionFailureReason(error),
                  this.ctx.logger,
                )
              }
            } else if (dispatched?.status === 'failed') {
              if (dispatched.reachedProvider === false) {
                await persistRefund(this.config.root, action, dispatched.detail, this.ctx.logger)
              }
              await persistBackendFailure(this.config.root, action, dispatched.detail, this.ctx.logger)
            } else if (dispatched?.status === 'started' && !dispatched.outcome) {
              await persistAgentHold(
                this.config.root,
                action.type === 'plan' ? null : action.taskId,
                'missing_agent_result',
                this.ctx.logger,
              )
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
      if (admitted) this.shared.release()
      this.busy = false
    }
  }
}

/**
 * Cordis constructs `(ctx, config)` only. Opt-in CLIs: `dsh`, `claude`,
 * `codex`. The default stays NoopBackend so tests without the third
 * constructor arg do not spawn. RecordingBackend is tests-only.
 */
export function createBackend(ctx: Context, config: Config): AgentBackend {
  if (config.agentBackend === 'routed') {
    const routes = [config.plannerRoute, config.reviewerRoute, ...Object.values(config.routing)]
    // Only register what a route actually names: RoutedBackend.health() probes
    // every registered adapter, so an unused one would demand its CLI be installed.
    const usesForge = routes.some(route => route.backend === 'forge')
    return new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, {
      dsh: new DshHeadlessBackend(),
      claude: new ClaudeCliBackend(),
      codex: new CodexCliBackend(),
      ...(usesForge ? { forge: new ForgePrBackend(config.forge) } : {}),
      subagent: new HarnessSubagentBackend(new CordisHarnessHost(ctx)),
    })
  }
  if (config.agentBackend === 'dsh') return new DshHeadlessBackend()
  if (config.agentBackend === 'claude') return new ClaudeCliBackend()
  if (config.agentBackend === 'codex') return new CodexCliBackend()
  return new NoopBackend()
}

/**
 * What the loops of one process share: dispatch slots, and the day's spend.
 *
 * Each project's STATE carries its own `costUsdDay`, so N projects could spend
 * N daily caps, and each runs one tick at a time behind its own `busy`, so N
 * projects are N concurrent dispatches. This is the one place both are bounded
 * across projects. A loop that is refused waits — its tick returns having done
 * nothing — rather than halting, because a halt asks its own project a question
 * whose answer lies in another project.
 */
export class LoopShared {
  private inFlight = 0
  private readonly loops = new Set<ProjectLoop>()

  constructor(
    private readonly maxConcurrent: number,
    /** Combined across projects; not consulted while only one loop exists. */
    private readonly maxCostUsdPerDay: number,
  ) {}

  add(loop: ProjectLoop): void {
    this.loops.add(loop)
  }

  remove(loop: ProjectLoop): void {
    this.loops.delete(loop)
  }

  /** Today's spend across every loop, each rolled to today the way its own budget would be. */
  spentToday(now: number): number {
    let total = 0
    for (const loop of this.loops) {
      if (loop.lastUsage) total += rollCostWindows(loop.lastUsage, now).costUsdDay
    }
    return total
  }

  /**
   * The cap that applies now, or null when it does not. With one loop, that
   * loop's own `maxCostUsdPerDay` already halts it with a gate that names the
   * cause; a shared cap equal to it would only turn that halt into silence.
   */
  cap(): number | null {
    return this.loops.size > 1 ? this.maxCostUsdPerDay : null
  }

  admit(now: number): boolean {
    if (this.inFlight >= this.maxConcurrent) return false
    const cap = this.cap()
    if (cap !== null && this.spentToday(now) >= cap) return false
    this.inFlight += 1
    return true
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }
}

/**
 * The plugin: every project this process runs, and the page that shows them.
 *
 * The process's own `root` always has a loop, as it did when there was only
 * one. Each project in the operator's registry gets one too. A loop with no
 * GOAL.md idles, exactly as the own root does, so arming a project *is*
 * starting it — there is no second "running" flag to fall out of step with the
 * files.
 */
export default class DevloopService extends Service {
  static inject = []
  static Config = ConfigSchema
  static readonly provide = 'devloop'

  private readonly config: Config
  readonly backend: AgentBackend
  private readonly shared: LoopShared
  private readonly own: ProjectLoop
  /** Registered projects, by realpath. */
  private readonly others = new Map<string, ProjectLoop>()
  private started = false
  /** Set by stop(): a registry read still in flight must not start loops after it. */
  private disposed = false
  private readonly ownRealRoot: string

  constructor(ctx: Context, rawConfig: Config, backend?: AgentBackend) {
    super(ctx, 'devloop')
    this.config = resolveConfig(rawConfig)
    this.ownRealRoot = realRoot(this.config.root)
    this.backend = backend ?? createBackend(ctx, this.config)
    this.shared = new LoopShared(this.config.budget.maxParallelWorkers, sharedDailyCap(this.config))
    this.own = new ProjectLoop(ctx.logger, this.config, this.backend, this.shared)
    this.shared.add(this.own)
    // Mounted whether or not the loop is enabled: a disabled loop's state is
    // still worth reading. Only the web profile has the services it waits on.
    mountDashboard(ctx, {
      ownRoot: this.config.root,
      home: dshHome(),
      browseRoot: browseRoot(),
      presence: root => this.presence(root),
      onOperatorAction: (project, verb) => {
        const loop = this.loopFor(project.root)
        if (!loop) return
        // A pause stops paying for work whose result it would discard.
        if (verb === 'pause') loop.abortDispatch()
        else loop.poke()
      },
      control: {
        addProject: root => this.addProject(root),
        removeProject: root => this.removeProject(root),
        spend: now => ({ costUsdDay: this.shared.spentToday(now), cap: this.shared.cap() }),
      },
    })
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
    if (this.started) return
    this.started = true
    this.own.start()
    void this.startRegistered()
  }

  /** The process's own loop, as before: tests and embedders drive it directly. */
  async tick(now = Date.now()): Promise<void> {
    await this.own.tick(now)
  }

  abortDispatch(): void {
    this.own.abortDispatch()
  }

  poke(): void {
    this.own.poke()
  }

  stop(): void {
    this.disposed = true
    this.own.stop()
    for (const loop of this.others.values()) {
      loop.stop()
      this.shared.remove(loop)
    }
    this.others.clear()
  }

  private async startRegistered(): Promise<void> {
    try {
      const list = await listProjects(this.config.root, dshHome())
      if (list.registryError) this.ctx.logger.error(`[dsh-devloop] ${list.registryError}`)
      for (const project of list.projects) if (!project.own) this.addProject(project.root)
    } catch (error) {
      this.ctx.logger.error('[dsh-devloop] project registry unreadable; only the own root runs', error)
    }
  }

  private addProject(root: string): void {
    if (!this.started || this.disposed || this.others.has(root) || root === this.ownRealRoot) return
    const name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
    const loop = new ProjectLoop(prefixed(this.ctx.logger, name), { ...this.config, root }, this.backend, this.shared)
    this.others.set(root, loop)
    this.shared.add(loop)
    loop.start()
    this.ctx.logger.info(`[dsh-devloop] project loop started root=${root}`)
  }

  private removeProject(root: string): void {
    const loop = this.others.get(root)
    if (!loop) return
    loop.stop()
    this.others.delete(root)
    this.shared.remove(loop)
  }

  private loopFor(root: string): ProjectLoop | undefined {
    if (root === this.ownRealRoot || root === this.config.root) return this.own
    return this.others.get(root)
  }

  private presence(root: string): LoopPresence {
    const loop = this.loopFor(root)
    if (!loop) return 'elsewhere'
    return loop.running ? 'running' : 'stopped'
  }
}

function realRoot(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

/** Unset (0) means the same figure as one project's daily cap: adding projects does not raise the total. */
function sharedDailyCap(config: Config): number {
  return config.maxCostUsdPerDayAllProjects > 0 ? config.maxCostUsdPerDayAllProjects : config.budget.maxCostUsdPerDay
}

function prefixed(logger: LoopLogger, name: string): LoopLogger {
  const tag = (message: unknown): unknown =>
    typeof message === 'string' ? message.replace('[dsh-devloop]', `[dsh-devloop:${name}]`) : message
  return {
    info: (message: unknown, ...rest: unknown[]) => logger.info(tag(message) as string, ...rest),
    error: (message: unknown, ...rest: unknown[]) => logger.error(tag(message) as string, ...rest),
  } as LoopLogger
}

function isolatedPlan(agentBackend: Config['agentBackend']): boolean {
  return agentBackend !== 'noop'
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
        await saveState(root, next, { expectedRevision: current.revision, action: 'cost:backend' })
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

const PENDING_HOLD_FILE = 'PENDING_HOLD'
const HOLD_REASON = /^[a-z_]+(?::[^\n]{0,200})?$/

function pendingHoldPath(root: string): string {
  return join(root, DEVLOOP_DIR, PENDING_HOLD_FILE)
}

/** A hold that could not be written because the lock stayed busy, kept for the next tick. */
async function writePendingHold(root: string, taskId: string | null, reason: HoldReason, log: { error(message: string, ...rest: unknown[]): void }): Promise<void> {
  const file = pendingHoldPath(root)
  const temp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({ taskId, reason })}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    log.error('[dsh-devloop] pending hold marker write failed', error)
  }
}

/**
 * The marker's hold; null when there is none; 'invalid' when one is there but
 * unusable; 'unreadable' when reading it failed for another reason (kept).
 */
async function readPendingHold(root: string): Promise<{ taskId: string | null, reason: HoldReason } | 'invalid' | 'unreadable' | null> {
  let handle
  try {
    handle = await open(pendingHoldPath(root), constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!(await handle.stat()).isFile()) return 'invalid'
    const value = JSON.parse(await handle.readFile('utf8')) as { taskId?: unknown, reason?: unknown }
    const taskId = value.taskId === null ? null : typeof value.taskId === 'string' && worktreeTaskToken(value.taskId) ? value.taskId : undefined
    if (taskId === undefined || typeof value.reason !== 'string' || !HOLD_REASON.test(value.reason)) return 'invalid'
    return { taskId, reason: value.reason as HoldReason }
  } catch (error) {
    // Only content can make a marker unusable: bad JSON, or a symlink (ELOOP under
    // O_NOFOLLOW). A transient error (EMFILE, EIO) must not delete a real hold —
    // it is read again next tick.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ELOOP') return 'invalid'
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
  } finally {
    await handle?.close().catch(() => undefined)
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
        await saveState(root, holdTask(current, taskId, 'parent_commit_failed'), {
          expectedRevision: current.revision,
          action: 'hold:parent_commit_failed',
        })
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

/** How long a finished dispatch waits for the state lock before its result is given up on. */
export const RESULT_LOCK_DEADLINE_MS = 60_000
const LOCK_RETRY_MS = 100

/** What the reviewer is told about an elastic-band change: its size against the budget the checker applied. */
export function elasticSummary(check: PreprResult): string {
  const size = check.size
  const parts = size ? [`${String(size.lines)} lines`, `${String(size.files)} files`, `${String(size.countedTopDirs.length)} top-level dirs`] : ['size unknown']
  const l = check.limits ?? {}
  const budget = [l.max_lines, l.max_files, l.max_top_dirs].every(n => n !== undefined)
    ? `; budget ${String(l.max_lines)}/${String(l.max_files)}/${String(l.max_top_dirs)}${[l.elastic_lines, l.elastic_files, l.elastic_top_dirs].every(n => n !== undefined) ? `, elastic to ${String(l.elastic_lines)}/${String(l.elastic_files)}/${String(l.elastic_top_dirs)}` : ''}`
    : ''
  return `${parts.join(', ')}${budget}`.slice(0, 200)
}

/**
 * Fold a validated result into STATE. A busy lock used to drop the result after
 * one try, and the loop halted on no_progress 15 minutes later — a resume then
 * paid for the same run again. The page's actions hold this lock only briefly,
 * so wait for it, rereading STATE on every attempt, until the deadline.
 */
export async function persistAgentTransition(
  root: string,
  action: AgentAction,
  dispatched: AgentRunResult & { readonly outcome: NonNullable<AgentRunResult['outcome']> },
  commit: { readonly sha: string, readonly overBudget?: string } | undefined,
  log: { error(message: string, ...rest: unknown[]): void },
  deadlineMs = RESULT_LOCK_DEADLINE_MS,
): Promise<void> {
  const fold = () => withStateLock(root, async () => {
    const now = Date.now()
    const current = await loadState(root, now)
    if (current.killSwitch || current.supervisor) throw new Error('stale_agent_result: loop is halted')
    const next = {
      ...applyAgentResult(current, action, dispatched.outcome, {
        agent: dispatched.agent ?? 'unknown',
        ...(commit === undefined ? {} : { implementationSha: commit.sha, overBudget: commit.overBudget }),
      }),
      updatedAt: new Date(now).toISOString(),
    }
    await saveState(root, next, {
      expectedRevision: current.revision,
      action: `result:${action.type}`,
    })
    await snapshotProgress(root, next, now, log)
  })
  const until = Date.now() + deadlineMs
  let folded = await fold()
  while (!folded.ok && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
    folded = await fold()
  }
  if (!folded.ok) throw new Error('result_transition_lock_busy')
}

/**
 * Hand back an attempt for a dispatch that never reached a provider. Advisory:
 * if the lock is busy the charge simply stands, which costs one attempt rather
 * than risking a write that races the loop.
 *
 * Deliberately does not retry the lock, unlike `persistAgentHold` and
 * `persistParentCommitHold` beside it. Those two are the loop's only way to
 * reach a human, so losing one wedges the run; a lost refund overcharges by a
 * single attempt, and `refusedDispatches` — which this also writes — is what
 * actually stops a broken route, so the bound holds either way.
 */
async function persistRefund(
  root: string,
  action: AgentAction,
  detail: string | undefined,
  log: { error(message: string, ...rest: unknown[]): void; info(message: string, ...rest: unknown[]): void },
): Promise<void> {
  try {
    const folded = await withStateLock(root, async () => {
      const now = Date.now()
      const current = await loadState(root, now)
      if (current.killSwitch || current.supervisor) return
      const next = { ...current, usage: refundAction(current.usage, action) }
      if (next.usage === current.usage) return
      await saveState(root, next, { expectedRevision: current.revision, action: 'budget:refund' })
    })
    if (!folded.ok) log.info(`[dsh-devloop] refund deferred: ${detail ?? 'lock held'}`)
  } catch (error) {
    log.error('[dsh-devloop] refund failed', error)
  }
}

async function persistBackendFailure(
  root: string,
  action: AgentAction,
  detail: string | undefined,
  log: { error(message: string, ...rest: unknown[]): void },
): Promise<void> {
  if (action.type !== 'delegate') {
    await persistAgentHold(root, action.type === 'plan' ? null : action.taskId, 'backend_failed', log)
    return
  }
  const folded = await withStateLock(root, async () => {
    const now = Date.now()
    const current = await loadState(root, now)
    if (current.killSwitch || current.supervisor) return
    // This reads the refunded count, so a refused dispatch leaves `attempts` at
    // 0 and the tick's dispatch-status latch freezes on `rework:0:0`. That is
    // why `dispatch_refused` is checked for every action rather than only for a
    // delegate: by the time it matters, the latch has already rewritten the
    // intended delegate to idle.
    const tasks = current.tasks.map(task => task.id === action.taskId
      ? { ...task, status: 'rework' as const, attempts: current.usage.taskAttempts[action.taskId] ?? task.attempts }
      : task)
    const next = { ...current, tasks, updatedAt: new Date(now).toISOString() }
    await saveState(root, next, {
      expectedRevision: current.revision,
      action: 'result:backend-failed',
    })
    await snapshotProgress(root, next, now, log)
  })
  if (!folded.ok) {
    log.error('[dsh-devloop] backend failure transition deferred', detail)
  }
}

export async function persistAgentHold(
  root: string,
  taskId: string | null,
  reason: HoldReason,
  log: { error(message: string, ...rest: unknown[]): void },
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const folded = await withStateLock(root, async () => {
        const current = await loadState(root, Date.now())
        if (current.killSwitch || current.supervisor) return
        await saveState(root, {
          ...current,
          supervisor: { taskId, reason },
          lastAction: { type: 'escalate', taskId, reason },
          updatedAt: new Date().toISOString(),
        }, { expectedRevision: current.revision, action: `hold:${reason}` })
      })
      if (folded.ok) return true
    } catch (error) {
      log.error('[dsh-devloop] agent hold failed', error)
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 50))
  }
  // Still busy: leave the hold where the next tick applies it under the lock, so a
  // contended lock ends in the specific halt rather than a generic no_progress one.
  await writePendingHold(root, taskId, reason, log)
  return false
}

function implementationFailureReason(error: unknown): HoldReason {
  const message = error instanceof Error ? error.message : ''
  if (message.startsWith('acceptance_failed:')) return `acceptance_failed:${message.slice('acceptance_failed:'.length).trim()}`
  for (const kind of ['task_over_budget', 'prepr_blocked', 'prepr_unavailable'] as const) {
    if (message.startsWith(`${kind}:`)) return `${kind}:${message.slice(kind.length + 1).trim()}`
  }
  if (message.startsWith('scope_violation:')) return 'scope_violation'
  if (message.startsWith('scope_check:')) return 'scope_check_failed'
  if (message === 'empty_task') return 'empty_task'
  return 'parent_commit_failed'
}

function transitionFailureReason(error: unknown): HoldReason {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('stale_review_sha')) return 'stale_review_sha'
  if (message.includes('reviewer_identity_matches_implementer')) return 'reviewer_identity_conflict'
  if (message.includes('result_kind_mismatch') || message.includes('result_task_mismatch')) return 'invalid_agent_result'
  return 'result_transition_failed'
}

function actionKeyForJournal(action: TickResult['action']): string {
  if (action.type === 'delegate' || action.type === 'review' || action.type === 'merge') {
    return `tick:${action.type}:${action.taskId}`
  }
  if (action.type === 'stop') return `tick:stop:${action.reason}`
  if (action.type === 'escalate') return `tick:escalate:${action.taskId ?? '_'}:${action.reason}`
  return `tick:${action.type}`
}

function finitePositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Where a task's merge happens: on the forge, when the forge is the review route; in the checkout otherwise. */
function mergesOnForge(config: Config): boolean {
  return config.agentBackend === 'routed' && config.reviewerRoute.backend === 'forge'
}

function mergeHoldReason(error: unknown): 'empty_task' | 'merge_wedged' | 'unknown_base' | 'unknown_review_sha' | 'stale_review_sha' | 'merge_onto_trunk' | 'merge_detached_head' | null {
  const message = error instanceof Error ? error.message : ''
  if (message.startsWith('empty_task')) return 'empty_task'
  if (message.startsWith('merge_onto_trunk')) return 'merge_onto_trunk'
  if (message.startsWith('merge_detached_head')) return 'merge_detached_head'
  if (message.startsWith('merge_wedged')) return 'merge_wedged'
  if (message.startsWith('unknown_base')) return 'unknown_base'
  if (message.startsWith('unknown_review_sha')) return 'unknown_review_sha'
  if (message.startsWith('stale_review_sha')) return 'stale_review_sha'
  return null
}

function holdTask(state: LoopState, taskId: string, reason: HoldReason): LoopState {
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
