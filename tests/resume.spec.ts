import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RecordingBackend } from '../src/backend.ts'
import { resolveConfig } from '../src/config.ts'
import { emptyState, loadState, saveState, writeBudgetSnapshot } from '../src/persist.ts'
import { runCli } from '../src/command.ts'
import { diagnoseHalt, integrityHold, resumeState } from '../src/resume.ts'
import DevloopService from '../src/service.ts'
import { runTick } from '../src/tick.ts'
import type { LoopState } from '../src/types.ts'
import { baseState, makeTask, mkdtempInRepo, withTasks } from './helpers.ts'

const execFileAsync = promisify(execFile)
const limits = resolveConfig({}).budget
const NOW = 1_000_000

function halted(overrides: Partial<LoopState> = {}): LoopState {
  return {
    ...baseState(),
    killSwitch: true,
    lastAction: { type: 'stop', reason: 'budget' },
    supervisor: { taskId: 'A', reason: 'max_task_attempts:A' },
    ...overrides,
  }
}

describe('diagnoseHalt', () => {
  it('says nothing is wrong with a running loop', () => {
    const state = withTasks(baseState(), [makeTask({ id: 'A', status: 'ready' })])
    const diagnosis = diagnoseHalt({ ...state, usage: { ...state.usage, lastProgressAt: NOW } }, limits, NOW)
    expect(diagnosis.halted).toBe(false)
    expect(diagnosis.wouldHaltAgain).toBeNull()
  })

  it('names every reason the loop is stopped', () => {
    const state = halted({ tasks: [makeTask({ id: 'A', status: 'failed' })] })
    const diagnosis = diagnoseHalt(state, limits, NOW)
    expect(diagnosis.halted).toBe(true)
    expect(diagnosis.reasons).toEqual(expect.arrayContaining([
      'killSwitch is set',
      'last action was stop:budget',
      'supervisor hold: max_task_attempts:A',
      'task A is failed',
    ]))
    expect(diagnosis.taskId).toBe('A')
  })

  it('warns when lifting the hold would change nothing', () => {
    // The attempt cap is still spent, so the very next tick stops again.
    const state = halted({
      tasks: [makeTask({ id: 'A', status: 'ready' })],
      usage: { ...baseState().usage, taskAttempts: { A: limits.maxTaskAttempts }, lastProgressAt: NOW },
    })
    expect(diagnoseHalt(state, limits, NOW).wouldHaltAgain).toBe(`max_task_attempts:A`)
  })

  it('reports a spend cap as the thing standing in the way', () => {
    const state = halted({
      tasks: [makeTask({ id: 'A', status: 'ready' })],
      usage: { ...baseState().usage, costUsdDay: limits.maxCostUsdPerDay, lastProgressAt: NOW },
    })
    expect(diagnoseHalt(state, limits, NOW).wouldHaltAgain).toBe('daily_cost_cap')
  })
})

describe('resumeState', () => {
  it('lifts the hold and the circuits keyed on stale history', () => {
    const state = halted({
      usage: { ...baseState().usage, lastActions: ['escalate:id:A:x', 'escalate:id:A:x'], lastProgressAt: 0 },
    })
    const next = resumeState(state, {}, NOW)
    expect(next.killSwitch).toBe(false)
    expect(next.supervisor).toBeNull()
    expect(next.lastAction).toEqual({ type: 'idle' })
    expect(next.lastDispatchStatus).toBeNull()
    expect(next.usage.lastActions).toEqual([])
    expect(next.usage.lastProgressAt).toBe(NOW)
  })

  it('leaves a spent attempt budget alone unless the task is named', () => {
    const state = halted({
      tasks: [makeTask({ id: 'A', status: 'ready' })],
      usage: { ...baseState().usage, taskAttempts: { A: limits.maxTaskAttempts } },
    })
    // Forgetting on its own that a task already burned its attempts is how an
    // unattended loop starts spending without end.
    expect(resumeState(state, {}, NOW).usage.taskAttempts['A']).toBe(limits.maxTaskAttempts)
    expect(diagnoseHalt(resumeState(state, {}, NOW), limits, NOW).wouldHaltAgain).toBe('max_task_attempts:A')

    const retried = resumeState(state, { taskId: 'A' }, NOW)
    expect(retried.usage.taskAttempts['A']).toBeUndefined()
    expect(diagnoseHalt(retried, limits, NOW).wouldHaltAgain).toBeNull()
  })

  it('sends a retried task back to the worker, never forward to a merge', () => {
    const state = halted({
      tasks: [makeTask({
        id: 'A',
        status: 'merge_ready',
        attempts: 3,
        reviewCycles: 2,
        lastReviewVerdict: 'PASS',
        reviewer: 'claude/opus',
      })],
    })
    const task = resumeState(state, { taskId: 'A' }, NOW).tasks[0]
    expect(task).toMatchObject({ status: 'rework', attempts: 0, reviewCycles: 0 })
    // A stale PASS must not survive into the next attempt.
    expect(task?.lastReviewVerdict).toBeUndefined()
    expect(task?.reviewer).toBeUndefined()
  })

  it('restarts the retried task lifetime so it does not time out at once', () => {
    // Past the task lifetime, so the clock alone would stop the loop again.
    const late = (limits.taskLifetimeMinutes + 10) * 60_000
    const state = halted({
      tasks: [makeTask({ id: 'A', status: 'ready' })],
      usage: { ...baseState().usage, taskStartedAt: { A: 0 }, lastProgressAt: late },
    })
    expect(diagnoseHalt(state, limits, late).wouldHaltAgain).toBe('task_timeout:A')
    expect(diagnoseHalt(resumeState(state, { taskId: 'A' }, late), limits, late).wouldHaltAgain).toBeNull()
  })

  it('keeps the daily spend cap until it is cleared on purpose', () => {
    const state = halted({
      tasks: [makeTask({ id: 'A', status: 'ready' })],
      usage: { ...baseState().usage, costUsdDay: limits.maxCostUsdPerDay, lastProgressAt: NOW },
    })
    expect(resumeState(state, {}, NOW).usage.costUsdDay).toBe(limits.maxCostUsdPerDay)
    expect(resumeState(state, { resetCost: true }, NOW).usage.costUsdDay).toBe(0)
  })

  it('rolls the daily window against the old anchor, not the new one', () => {
    // lastProgressAt is the UTC-day anchor. Moving it before the roll would
    // stamp yesterday's spend as today's and keep the cap tripped for good.
    const yesterday = Date.UTC(2026, 0, 1, 12)
    const today = Date.UTC(2026, 0, 2, 12)
    const state = halted({
      tasks: [makeTask({ id: 'A', status: 'ready' })],
      usage: { ...baseState().usage, costUsdDay: limits.maxCostUsdPerDay, lastProgressAt: yesterday },
    })
    expect(resumeState(state, {}, today).usage.costUsdDay).toBe(0)
    expect(resumeState(state, {}, yesterday + 60_000).usage.costUsdDay).toBe(limits.maxCostUsdPerDay)
  })

  it('clears the session window, which restarting the profile clears anyway', () => {
    const state = halted({
      tasks: [makeTask({ id: 'A', status: 'ready' })],
      usage: { ...baseState().usage, costUsdSession: limits.maxCostUsdPerSession, lastProgressAt: NOW },
    })
    expect(resumeState(state, {}, NOW).usage.costUsdSession).toBe(0)
  })

  it('refuses to write over state the host could not trust', () => {
    for (const reason of ['invalid_state', 'unreadable_state', 'escaped_devloop']) {
      const corrupt = halted({ supervisor: { taskId: null, reason }, tasks: [] })
      expect(integrityHold(corrupt)).toBe(reason)
      // Resuming would persist a synthesised empty loop over the real history.
      expect(() => resumeState(corrupt, {}, NOW)).toThrow(/refusing to overwrite/)
      expect(diagnoseHalt(corrupt, limits, NOW).integrityHold).toBe(reason)
    }
  })

  it('calls a terminal action blocked even when no breaker tripped', () => {
    const done = halted({ goalCompleted: true, tasks: [makeTask({ id: 'A', status: 'done' })] })
    expect(diagnoseHalt(done, limits, NOW).wouldHaltAgain).toBe('stop:goal_complete')

    // A blocked task only ever escalates, so a plain resume achieves nothing.
    const blocked = halted({ tasks: [makeTask({ id: 'A', status: 'blocked' })] })
    expect(diagnoseHalt(blocked, limits, NOW).wouldHaltAgain).toBe('escalate:blocked_task')
    expect(diagnoseHalt(blocked, limits, NOW, { taskId: 'A' }).wouldHaltAgain).toBeNull()

    // Policy routes a high-risk task to a human; no retry changes that.
    const risky = halted({ tasks: [makeTask({ id: 'A', status: 'ready', risk: 'high' })] })
    expect(diagnoseHalt(risky, limits, NOW, { taskId: 'A' }).wouldHaltAgain).toBe('escalate:security_high_risk')
  })

  it('only unfinishes a goal when a task is reopened', () => {
    const done = halted({ goalCompleted: true, tasks: [makeTask({ id: 'A', status: 'done' })] })
    expect(resumeState(done, {}, NOW).goalCompleted).toBe(true)
    expect(resumeState(done, { taskId: 'A' }, NOW).goalCompleted).toBe(false)
  })

  it('refuses to retry a task that does not exist', () => {
    expect(() => resumeState(halted(), { taskId: 'ghost' }, NOW)).toThrow(/no task ghost/)
  })

  it('lets the loop take the next action again', () => {
    const state = halted({ tasks: [makeTask({ id: 'A', status: 'ready' })] })
    expect(runTick(state, limits, NOW).action).toEqual({ type: 'stop', reason: 'budget' })
    const beat = runTick(resumeState(state, { taskId: 'A' }, NOW), limits, NOW + 1)
    expect(beat.action).toEqual({ type: 'delegate', taskId: 'A' })
  })
})

describe('the devloop command', () => {
  const services: DevloopService[] = []
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
  })

  const scratch: string[] = []
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  /** No git repository: resume only touches `.devloop`, and spinning one up per
   *  case starved the heavier suites enough to time them out. */
  async function armed(state: LoopState): Promise<string> {
    const root = await mkdtempInRepo('devloop-resume-')
    scratch.push(root)
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await saveState(root, state)
    return root
  }

  /** In-process: a subprocess per case would starve the heavier suites. */
  async function devloop(root: string, args: readonly string[]): Promise<{ code: number; out: string }> {
    const result = await runCli([...args, root])
    return { code: result.code, out: `${result.out}${result.err}` }
  }

  it('reports a halt and exits non-zero, then clears it', async () => {
    const root = await armed({
      ...emptyState(NOW),
      killSwitch: true,
      lastAction: { type: 'stop', reason: 'budget' },
      supervisor: { taskId: 'A', reason: 'blocked_task' },
      tasks: [makeTask({ id: 'A', status: 'blocked' })],
    })

    const before = await devloop(root, ['status'])
    expect(before.code).toBe(1)
    expect(before.out).toContain('killSwitch is set')
    expect(before.out).toContain('task A is blocked')

    const resumed = await devloop(root, ['resume', '--task', 'A'])
    expect(resumed.code).toBe(0)
    expect(resumed.out).toContain('restart the DSH profile')

    const state = await loadState(root, Date.now())
    expect(state.killSwitch).toBe(false)
    expect(state.supervisor).toBeNull()
    expect(state.tasks[0]?.status).toBe('rework')
    // The write goes through the same revision-checked, journalled path.
    expect(state.revision).toBeGreaterThan(1)

    const after = await devloop(root, ['status'])
    expect(after.code).toBe(0)
    expect(after.out).toContain('not halted')
  })

  it('says so when resuming would not actually help', async () => {
    // Anchored to today, or the daily window would roll and clear the cap.
    const today = Date.now()
    const root = await armed({
      ...emptyState(today),
      killSwitch: true,
      lastAction: { type: 'stop', reason: 'budget' },
      tasks: [makeTask({ id: 'A', status: 'ready' })],
      usage: { ...emptyState(today).usage, costUsdDay: limits.maxCostUsdPerDay },
    })
    const resumed = await devloop(root, ['resume'])
    expect(resumed.code).toBe(1)
    expect(resumed.out).toContain('daily_cost_cap')
    expect(resumed.out).toContain('stop again on the next tick')
  })

  it('runs through the shim a package manager installs, not just the file', async () => {
    // The one subprocess in this suite. Invoking lib/bin/devloop.js directly
    // would not prove the bin entry works: an installed shim resolves through
    // node_modules/.bin, and a main-guard that compares paths can silently
    // decide it is not the entrypoint and exit 0 without doing anything.
    const root = await armed({ ...emptyState(NOW), tasks: [makeTask({ id: 'A', status: 'ready' })] })
    // A package-manager shim is a link, and Node resolves an ESM entry to its
    // real path: that mismatch is exactly what a path-comparing guard gets wrong.
    const shimDir = await mkdtempInRepo('devloop-shim-')
    scratch.push(shimDir)
    const shim = join(shimDir, 'devloop')
    await symlink(join(import.meta.dirname, '..', 'lib', 'bin', 'devloop.js'), shim)
    // Node resolves an ESM entry to its real path while argv[1] keeps the link,
    // which is precisely what a path-comparing main guard gets wrong.
    const { stdout } = await execFileAsync(process.execPath, [shim, 'status', root], { encoding: 'utf8' })
    expect(stdout).toContain('not halted')
  })

  it('diagnoses with the profile budgets the running loop recorded', async () => {
    const root = await armed({
      ...emptyState(NOW),
      tasks: [makeTask({ id: 'A', status: 'ready' })],
      usage: { ...emptyState(NOW).usage, taskAttempts: { A: 3 } },
    })
    // Default limits allow 3 attempts, so nothing looks wrong.
    expect((await devloop(root, ['status'])).out).toContain('default budgets')

    // The profile this workspace actually runs allows only one.
    await writeBudgetSnapshot(root, { ...limits, maxTaskAttempts: 1 })
    const strict = await devloop(root, ['status'])
    expect(strict.out).toContain('profile budgets')
    expect(strict.out).toContain('max_task_attempts:A')
    expect(strict.code).toBe(1)
  })

  it('will not overwrite a STATE.json the host could not parse', async () => {
    // No journal to recover from, so the host synthesises an empty halted state;
    // writing that back would erase the real task history.
    const root = await mkdtempInRepo('devloop-corrupt-')
    scratch.push(root)
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await writeFile(join(root, '.devloop', 'STATE.json'), '{ not json', 'utf8')
    const result = await devloop(root, ['resume'])
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/refusing to overwrite|cannot be trusted/)
    // The unparseable file is left exactly as it was, for a human to look at.
    expect(await readFile(join(root, '.devloop', 'STATE.json'), 'utf8')).toBe('{ not json')
  })

  it('rejects resume-only flags on status', async () => {
    const root = await armed({ ...emptyState(NOW), tasks: [makeTask({ id: 'A', status: 'ready' })] })
    const result = await devloop(root, ['status', '--reset-cost'])
    expect(result.code).toBe(2)
    expect(result.out).toContain('only meaningful for resume')
  })

  it('refuses a workspace that was never armed', async () => {
    const root = await mkdtempInRepo('devloop-unarmed-')
    scratch.push(root)
    const result = await devloop(root, ['status'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('no .devloop/GOAL.md')
  })

  /**
   * The documented limitation, measured rather than assumed: the plugin
   * disposes its timer when the loop halts, so a resumed STATE does not restart
   * it on its own. Re-arming the running service without a restart is a
   * separate change.
   */
  it('does not restart a service that already halted', async () => {
    const root = await armed({
      ...emptyState(NOW),
      killSwitch: true,
      lastAction: { type: 'stop', reason: 'budget' },
      tasks: [makeTask({ id: 'A', status: 'ready' })],
    })
    const backend = new RecordingBackend()
    const service = new DevloopService(new Context(), resolveConfig({ root, enabled: false }), backend)
    services.push(service)

    await service.tick()
    expect(backend.runs).toHaveLength(0)

    await devloop(root, ['resume'])
    await service.tick()
    // Still nothing: the service stopped itself on the first tick.
    expect(backend.runs).toHaveLength(0)
  })
})
