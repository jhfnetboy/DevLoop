import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RoutedBackend, type AgentBackend, type AgentRunInput, type AgentRunResult } from '../src/backend.ts'
import { refundAction } from '../src/budget.ts'
import { ClaudeCliBackend } from '../src/cli.ts'
import { resolveConfig } from '../src/config.ts'
import { ForgePrBackend } from '../src/forge.ts'
import { gateFor } from '../src/gate.ts'
import { emptyState, loadState, saveState } from '../src/persist.ts'
import DevloopService from '../src/service.ts'
import { resumeState } from '../src/resume.ts'
import { runTick } from '../src/tick.ts'
import { baseState, initGitRepo, makeTask, mkdtempInRepo, withTasks } from './helpers.ts'

const limits = resolveConfig({}).budget

describe('refundAction', () => {
  it('gives back one attempt, and only for the task that was dispatched', () => {
    const usage = { ...baseState().usage, taskAttempts: { A: 2, B: 5 } }
    const next = refundAction(usage, { type: 'delegate', taskId: 'A' })
    expect(next.taskAttempts).toEqual({ A: 1, B: 5 })
  })

  it('gives back a review cycle for a review', () => {
    const usage = { ...baseState().usage, reviewCycles: { A: 2 } }
    expect(refundAction(usage, { type: 'review', taskId: 'A' }).reviewCycles).toEqual({ A: 1 })
  })

  it('never goes below zero, and never invents a task', () => {
    const usage = baseState().usage
    expect(refundAction(usage, { type: 'delegate', taskId: 'ghost' }).taskAttempts).toEqual({})
    const zeroed = { ...usage, taskAttempts: { A: 0 } }
    expect(refundAction(zeroed, { type: 'delegate', taskId: 'A' }).taskAttempts).toEqual({ A: 0 })
  })

  it('leaves the record that the loop tried', () => {
    // The duplicate-action window and the lifetime clock are about what was
    // attempted, not what was spent; a refund must not erase them.
    const usage = {
      ...baseState().usage,
      taskAttempts: { A: 1 },
      lastActions: ['delegate:A'],
      taskStartedAt: { A: 42 },
    }
    const next = refundAction(usage, { type: 'delegate', taskId: 'A' })
    expect(next.lastActions).toEqual(['delegate:A'])
    expect(next.taskStartedAt).toEqual({ A: 42 })
  })

  it('does nothing for actions that spend no per-task budget', () => {
    const usage = { ...baseState().usage, taskAttempts: { A: 1 } }
    expect(refundAction(usage, { type: 'plan' })).toBe(usage)
  })
})

describe('which failures say they never reached a provider', () => {
  const contract = (root: string) => ({
    action: { type: 'review' as const, taskId: 'A' },
    contract: null,
    workspaceRoot: root,
    worktreeRoot: root,
  })

  it('a route with no adapter registered', async () => {
    const config = resolveConfig({})
    const routed = new RoutedBackend({
      planner: { tier: 'T3', backend: 'nowhere', model: 'x' },
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, {})
    const result = await routed.run({ action: { type: 'plan' }, contract: null, workspaceRoot: '/r', worktreeRoot: null })
    expect(result).toMatchObject({ status: 'failed', reachedProvider: false })
  })

  it('a reviewer route that matches the implementer', async () => {
    const config = resolveConfig({ reviewerRoute: { tier: 'T3', backend: 'dsh', model: 'deepseek-v4-flash' } })
    const routed = new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, { dsh: { async run() { return { status: 'started' } }, async cancel() {}, async health() { return 'ok' } } })
    const state = withTasks(baseState(), [makeTask({ id: 'A', status: 'review_pending' })])
    const { runInputFor } = await import('../src/backend.ts')
    const result = await routed.run(runInputFor('/r', { type: 'review', taskId: 'A' }, state, limits))
    expect(result).toMatchObject({ status: 'failed', reachedProvider: false })
  })

  it('a T3 CLI asked to run at the workspace root', async () => {
    const result = await new ClaudeCliBackend(async () => ({ stdout: '', stderr: '' })).run(contract('/repo'))
    expect(result).toMatchObject({ status: 'failed', reachedProvider: false })
  })

  it('a forge review with nothing configured to review with', async () => {
    const result = await new ForgePrBackend({ reviewers: [] }, async () => ({ stdout: '', stderr: '' }))
      .run({ ...contract('/repo'), worktreeRoot: '/repo/wt' })
    expect(result).toMatchObject({ status: 'failed', reachedProvider: false })
  })

  it('but not a provider that ran and failed', async () => {
    // A model that ran and threw has been attempted; that attempt is spent.
    const angry: AgentBackend = {
      async run(): Promise<AgentRunResult> { return { status: 'failed', detail: 'the model errored' } },
      async cancel() {}, async health() { return 'ok' },
    }
    const result = await angry.run({ action: { type: 'plan' }, contract: null, workspaceRoot: '/r', worktreeRoot: null })
    expect(result.reachedProvider).toBeUndefined()
  })
})

describe('the attempt budget survives a misconfiguration', () => {
  const services: DevloopService[] = []
  afterEach(() => { for (const s of services.splice(0)) s.stop() })

  /**
   * The load-bearing case. A route that names no adapter can never succeed by
   * retrying, so charging it attempts spends a task's whole budget on something
   * the operator has to fix. Asserting only that a refund function exists would
   * not notice if nothing ever called it.
   */
  it('does not spend attempts on a dispatch that never reached a model', async () => {
    const root = await mkdtempInRepo('devloop-refund-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready' })],
    })
    const unreachable: AgentBackend = {
      async run(_input: AgentRunInput): Promise<AgentRunResult> {
        return { status: 'failed', detail: 'no backend adapter registered', reachedProvider: false }
      },
      async cancel() {}, async health() { return 'ok' },
    }
    const service = new DevloopService(new Context(), resolveConfig({ root, enabled: false }), unreachable)
    services.push(service)

    await service.tick()
    const after = await loadState(root, Date.now())
    expect(after.usage.taskAttempts['d1'] ?? 0).toBe(0)
    // Still bounded: the loop recorded that it tried.
    expect(after.usage.lastActions).toContain('delegate:d1')
    await rm(root, { recursive: true, force: true })
  })

  /**
   * The case the single-tick test above cannot see. A refunded attempt is free,
   * so a route that refuses every dispatch used to net back to zero forever:
   * `max_task_attempts` never fired, the tick's dispatch-status latch froze on
   * `rework:0:0`, and the task stopped being dispatched at all — visible only
   * when a generic no-progress timer eventually halted the whole loop.
   */
  it('names the broken task instead of waiting for a generic no-progress stop', async () => {
    const root = await mkdtempInRepo('devloop-refused-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready' })],
    })
    const unreachable: AgentBackend = {
      async run(_input: AgentRunInput): Promise<AgentRunResult> {
        return { status: 'failed', detail: 'no backend adapter registered', reachedProvider: false }
      },
      async cancel() {}, async health() { return 'ok' },
    }
    const service = new DevloopService(new Context(), resolveConfig({ root, enabled: false }), unreachable)
    services.push(service)

    for (let beat = 0; beat < 6; beat += 1) await service.tick()
    const after = await loadState(root, Date.now())

    // Still free: the point of the refund survives.
    expect(after.usage.taskAttempts['d1'] ?? 0).toBe(0)
    // But no longer invisible.
    expect(after.usage.refusedDispatches['d1']).toBeGreaterThanOrEqual(limits.maxRefusedDispatches)
    expect(after.supervisor?.reason).toBe('dispatch_refused:d1')
    // Named, not generic: the whole loop is not stopped for one bad route.
    expect(after.supervisor?.taskId).toBe('d1')
    await rm(root, { recursive: true, force: true })
  })

  it('asks the operator to fix the route, since retrying it cannot', () => {
    const held = {
      ...withTasks(baseState(), [makeTask({ id: 'd1', status: 'rework' })]),
      killSwitch: true,
      lastAction: { type: 'stop' as const, reason: 'budget' as const },
      supervisor: { taskId: 'd1', reason: 'dispatch_refused:d1' },
    }
    const gate = gateFor(held, limits, 1_000_000)
    expect(gate?.question).toMatch(/refused/i)
    expect(gate?.manual).toMatch(/route/i)
  })

  /**
   * The control. Without it, "stop refunding at all" also passes the test
   * above — and that is the behaviour this whole PR exists to remove.
   */
  it('still spends an attempt when the dispatch did reach a model and failed there', async () => {
    const root = await mkdtempInRepo('devloop-reached-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready' })],
    })
    const reached: AgentBackend = {
      async run(_input: AgentRunInput): Promise<AgentRunResult> {
        // reachedProvider left unset: the model was reached and failed there.
        return { status: 'failed', detail: 'the model errored' }
      },
      async cancel() {}, async health() { return 'ok' },
    }
    const service = new DevloopService(new Context(), resolveConfig({ root, enabled: false }), reached)
    services.push(service)

    await service.tick()
    const after = await loadState(root, Date.now())
    expect(after.usage.taskAttempts['d1']).toBe(1)
    expect(after.usage.refusedDispatches['d1'] ?? 0).toBe(0)
    expect(after.tasks[0]?.attempts).toBe(1)
    await rm(root, { recursive: true, force: true })
  })

  /**
   * The halt has to be answerable. `dispatch_refused` says the operator must go
   * and fix a route, so the answer that follows is `retry` — and if the counter
   * that caused the halt survived it, the very next tick would halt again and
   * the CLI could never get the loop moving.
   */
  it('lets a retry run once the operator has fixed what the halt named', () => {
    const halted = {
      ...withTasks(baseState(), [makeTask({ id: 'd1', status: 'rework' })]),
      killSwitch: true,
      lastAction: { type: 'stop' as const, reason: 'budget' as const },
      supervisor: { taskId: 'd1', reason: 'dispatch_refused:d1' },
      usage: {
        ...baseState().usage,
        refusedDispatches: { d1: limits.maxRefusedDispatches, other: 1 },
      },
    }
    const resumed = resumeState(halted, { taskId: 'd1' }, 2_000_000)
    // Cleared for the task the operator reopened...
    expect(resumed.usage.refusedDispatches['d1'] ?? 0).toBe(0)
    // ...and only that one: another task's record is not collateral.
    expect(resumed.usage.refusedDispatches['other']).toBe(1)
    // The whole point: the next tick must actually dispatch.
    expect(runTick(resumed, limits, 2_001_000).action).toEqual({ type: 'delegate', taskId: 'd1' })
  })

  it('still stops a task that keeps failing for real', async () => {
    // The refund must not become a way to retry forever.
    let state = withTasks(baseState(), [makeTask({ id: 'A', status: 'ready' })])
    for (let i = 0; i < limits.maxTaskAttempts; i += 1) {
      const beat = runTick(state, limits, (i + 1) * 1_000)
      expect(beat.action).toEqual({ type: 'delegate', taskId: 'A' })
      // What a real failed implementation writes back: rework, one more attempt.
      state = { ...beat.state, tasks: [makeTask({ id: 'A', status: 'rework', attempts: i + 1 })] }
    }
    expect(state.usage.taskAttempts['A']).toBe(limits.maxTaskAttempts)
    expect(runTick(state, limits, 99_000).action).toEqual({ type: 'stop', reason: 'budget' })
  })
})
