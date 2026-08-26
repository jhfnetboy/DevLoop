import { mkdir, mkdtemp, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { emptyState, loadState, LOCK_STALE_MS, lockPath, saveState, withStateLock, workspaceArmed } from '../src/persist.ts'
import { runTick } from '../src/tick.ts'
import type { Task } from '../src/types.ts'

function sampleTask(status: Task['status'] = 'ready'): Task {
  return {
    id: 't-1',
    title: 'crud',
    tier: 'T1',
    status,
    risk: 'low',
    attempts: 0,
    reviewCycles: 0,
    allowedPaths: ['src/**'],
    acceptance: ['tests pass'],
  }
}

describe('persist and tick', () => {
  it('reports a workspace as unarmed when .devloop is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    expect(await workspaceArmed(root)).toBe(false)
  })

  it('reports a workspace as unarmed when GOAL.md is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    expect(await workspaceArmed(root)).toBe(false)
  })

  it('halts on malformed STATE.json instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'STATE.json'), '{not-json', 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.lastAction).toEqual({ type: 'stop', reason: 'kill_switch' })
  })

  it('halts when supervisor is omitted from STATE.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    const state = { ...emptyState(0) } as Record<string, unknown>
    delete state.supervisor
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify(state), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('halts when updatedAt is omitted from STATE.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    const state = { ...emptyState(0) } as Record<string, unknown>
    delete state.updatedAt
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify(state), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('halts when a supervisor reason is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      ...emptyState(0),
      supervisor: { taskId: 'a', reason: '' },
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('halts when a running task has no start time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      ...emptyState(0),
      tasks: [sampleTask('running')],
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('halts when usage omits a hard-cap field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    const usage = { ...emptyState(0).usage } as Record<string, unknown>
    delete usage.costUsdDay
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      version: 1,
      goalCompleted: false,
      killSwitch: false,
      supervisor: null,
      tasks: [],
      usage,
      lastAction: { type: 'idle' },
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('returns locked when another holder owns LOCK', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = withStateLock(root, async () => {
      entered()
      await new Promise<void>(resolve => {
        release = resolve
      })
      return 'inside'
    })
    await started
    expect(await withStateLock(root, async () => 'second')).toEqual({ ok: false })
    release()
    expect(await held).toEqual({ ok: true, value: 'inside' })
  })

  it('halts on partial usage that would crash evaluateBudget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      version: 1,
      goalCompleted: false,
      killSwitch: false,
      supervisor: null,
      tasks: [],
      usage: {},
      lastAction: { type: 'idle' },
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('halts when a task record is missing required fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      ...emptyState(0),
      tasks: [{ id: 't-1', status: 'ready', tier: 'T1' }],
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('halts when persisted attempts are negative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      ...emptyState(0),
      usage: { ...emptyState(0).usage, taskAttempts: { 't-1': -1 } },
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('loads prototype-reserved task ids instead of killing the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      ...emptyState(0),
      tasks: [{
        id: '__proto__',
        title: 'ok',
        tier: 'T1',
        status: 'ready',
        risk: 'low',
        attempts: 0,
        reviewCycles: 0,
        allowedPaths: ['src/**'],
        acceptance: ['ok'],
      }],
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(false)
    expect(loaded.tasks[0]?.id).toBe('__proto__')
  })

  it('loads a toString task id instead of killing the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      ...emptyState(0),
      tasks: [{
        id: 'toString',
        title: 'ok',
        tier: 'T1',
        status: 'ready',
        risk: 'low',
        attempts: 0,
        reviewCycles: 0,
        allowedPaths: ['src/**'],
        acceptance: ['ok'],
      }],
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(false)
    expect(loaded.tasks[0]?.id).toBe('toString')
  })

  it('halts when two tasks share an id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    const task = {
      id: 't-1',
      title: 'dup',
      tier: 'T1',
      status: 'ready',
      risk: 'low',
      attempts: 0,
      reviewCycles: 0,
      allowedPaths: ['src/**'],
      acceptance: ['ok'],
    }
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      ...emptyState(0),
      tasks: [task, { ...task, status: 'running' }],
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('round-trips STATE.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    const state = emptyState(1)
    await saveState(root, state)
    const loaded = await loadState(root, 2)
    expect(loaded.version).toBe(1)
    expect(loaded.lastAction).toEqual({ type: 'idle' })
  })

  it('records plan when the armed workspace has no tasks', () => {
    const result = runTick(emptyState(0), resolveConfig({}).budget, 10)
    expect(result.action).toEqual({ type: 'plan' })
    expect(result.state.lastAction).toEqual({ type: 'plan' })
    expect(result.skipped).toBe(false)
  })

  it('latches a repeated plan instead of rewriting state', () => {
    const limits = resolveConfig({}).budget
    const first = runTick(emptyState(0), limits, 10)
    const second = runTick(first.state, limits, 20)
    expect(second.skipped).toBe(true)
    expect(second.state.lastAction).toEqual({ type: 'plan' })
    expect(second.state.updatedAt).toBe(first.state.updatedAt)
  })

  it('halts for no-progress after a latched plan sits idle', () => {
    const limits = resolveConfig({}).budget
    const first = runTick(emptyState(0), limits, 10)
    const later = runTick(first.state, limits, 10 + limits.noProgressMinutes * 60_000)
    expect(later.skipped).toBe(false)
    expect(later.action).toEqual({ type: 'stop', reason: 'budget' })
    expect(later.state.killSwitch).toBe(true)
    expect(later.state.supervisor?.reason).toBe('no_progress')
  })

  it('keeps an existing supervisor hold when the watchdog stops', () => {
    const limits = resolveConfig({}).budget
    const first = runTick({
      ...emptyState(0),
      supervisor: { taskId: 'a', reason: 'security_high_risk' },
    }, limits, 10)
    expect(first.action).toEqual({
      type: 'escalate',
      taskId: 'a',
      reason: 'security_high_risk',
    })
    const later = runTick(first.state, limits, 10 + limits.noProgressMinutes * 60_000)
    expect(later.action).toEqual({ type: 'stop', reason: 'budget' })
    expect(later.state.supervisor).toEqual({ taskId: 'a', reason: 'security_high_risk' })
  })

  it('increments delegate attempts on a recorded tick', () => {
    const result = runTick({ ...emptyState(0), tasks: [sampleTask()] }, resolveConfig({}).budget, 10)
    expect(result.action).toEqual({ type: 'delegate', taskId: 't-1' })
    expect(result.state.usage.taskAttempts['t-1']).toBe(1)
    expect(result.state.usage.taskStartedAt['t-1']).toBe(10)
  })

  it('allows a rework delegate after a running skip', () => {
    const limits = resolveConfig({}).budget
    const first = runTick({ ...emptyState(0), tasks: [sampleTask('ready')] }, limits, 10)
    const running = runTick({
      ...first.state,
      tasks: [sampleTask('running')],
    }, limits, 20)
    expect(running.skipped).toBe(true)
    const retry = runTick({
      ...running.state,
      tasks: [sampleTask('rework')],
    }, limits, 30)
    expect(retry.skipped).toBe(false)
    expect(retry.action).toEqual({ type: 'delegate', taskId: 't-1' })
    expect(retry.state.usage.taskAttempts['t-1']).toBe(2)
  })

  it('re-delegates when ready is re-armed with a higher attempt count', () => {
    const limits = resolveConfig({}).budget
    const first = runTick({ ...emptyState(0), tasks: [sampleTask('ready')] }, limits, 10)
    const retry = runTick({
      ...first.state,
      tasks: [{ ...sampleTask('ready'), attempts: 1 }],
    }, limits, 20)
    expect(retry.skipped).toBe(false)
    expect(retry.action).toEqual({ type: 'delegate', taskId: 't-1' })
  })

  it('still latches ready when attempts did not change', () => {
    const limits = resolveConfig({}).budget
    const first = runTick({ ...emptyState(0), tasks: [sampleTask('ready')] }, limits, 10)
    const again = runTick({
      ...first.state,
      tasks: [sampleTask('ready')],
    }, limits, 20)
    expect(again.skipped).toBe(true)
  })

  it('re-reviews when review_pending is re-armed with a higher reviewCycles', () => {
    const limits = resolveConfig({}).budget
    const first = runTick({
      ...emptyState(0),
      tasks: [sampleTask('review_pending')],
    }, limits, 10)
    const retry = runTick({
      ...first.state,
      tasks: [{ ...sampleTask('review_pending'), reviewCycles: 1 }],
    }, limits, 20)
    expect(retry.skipped).toBe(false)
    expect(retry.action).toEqual({ type: 'review', taskId: 't-1' })
  })

  it('does not latch rework when lastDispatchStatus is missing', () => {
    const limits = resolveConfig({}).budget
    const first = runTick({ ...emptyState(0), tasks: [sampleTask('ready')] }, limits, 10)
    const { lastDispatchStatus: _omitted, ...rest } = first.state
    const retry = runTick({
      ...rest,
      tasks: [sampleTask('rework')],
    }, limits, 20)
    expect(retry.skipped).toBe(false)
    expect(retry.action).toEqual({ type: 'delegate', taskId: 't-1' })
  })

  it('halts on a stop action missing its reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({
      ...emptyState(0),
      lastAction: { type: 'stop' },
    }), 'utf8')
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('invalid_state')
  })

  it('steals a lock whose holder pid is dead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(lockPath(root), '2147483647', 'utf8')
    expect(await withStateLock(root, async () => 'stolen')).toEqual({ ok: true, value: 'stolen' })
  })

  it('recovers a takeover claim whose holder pid is dead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(lockPath(root), '2147483647', 'utf8')
    await writeFile(`${lockPath(root)}.taking.2147483647`, '2147483647', 'utf8')
    expect(await withStateLock(root, async () => 'stolen')).toEqual({ ok: true, value: 'stolen' })
  })

  it('recovers an empty takeover claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(lockPath(root), '2147483647', 'utf8')
    await writeFile(`${lockPath(root)}.taking.2147483647`, '', 'utf8')
    expect(await withStateLock(root, async () => 'stolen')).toEqual({ ok: true, value: 'stolen' })
  })

  it('steals a stale lock even when the recorded pid is still alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    const file = lockPath(root)
    await writeFile(file, '1', 'utf8')
    const past = new Date(Date.now() - LOCK_STALE_MS - 1_000)
    await utimes(file, past, past)
    expect(await withStateLock(root, async () => 'stolen')).toEqual({ ok: true, value: 'stolen' })
  })

  it('does not steal a fresh lock from a live holder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    const file = lockPath(root)
    await writeFile(file, String(process.pid), 'utf8')
    expect(await withStateLock(root, async () => 'no')).toEqual({ ok: false })
  })

  it('stops on budget instead of delegating forever', () => {
    const blown = {
      ...emptyState(0),
      tasks: [sampleTask()],
      usage: { ...emptyState(0).usage, taskAttempts: { 't-1': 3 } },
    }
    const result = runTick(blown, resolveConfig({}).budget, 10)
    expect(result.action).toEqual({ type: 'stop', reason: 'budget' })
    expect(result.state.supervisor?.reason).toBe('max_task_attempts:t-1')
  })

  it('attributes a timeout stop to the timed-out task', () => {
    const result = runTick({
      ...emptyState(0),
      tasks: [sampleTask('running'), { ...sampleTask('ready'), id: 't-2' }],
      usage: {
        ...emptyState(0).usage,
        taskStartedAt: { 't-1': 0 },
        lastProgressAt: 44 * 60_000,
      },
    }, resolveConfig({}).budget, 45 * 60_000)
    expect(result.action).toEqual({ type: 'stop', reason: 'budget' })
    expect(result.state.supervisor).toEqual({ taskId: 't-1', reason: 'task_timeout:t-1' })
  })

  it('keeps goal_complete instead of rewriting it as a budget stop', () => {
    const result = runTick({
      ...emptyState(0),
      tasks: [sampleTask('done')],
      usage: { ...emptyState(0).usage, costUsdDay: 20 },
    }, resolveConfig({}).budget, 10)
    expect(result.action).toEqual({ type: 'stop', reason: 'goal_complete' })
    expect(result.state.killSwitch).toBe(true)
    expect(result.state.supervisor).toBeNull()
  })

  it('writes the recorded action onto disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    const result = runTick(emptyState(0), resolveConfig({}).budget, 10)
    await saveState(root, result.state)
    const raw = await readFile(join(root, '.devloop', 'STATE.json'), 'utf8')
    expect(raw).toContain('"type": "plan"')
  })

  it('keeps takeover claims beside LOCK when the body has path separators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(lockPath(root), '../outside', 'utf8')
    expect(await withStateLock(root, async () => 'stolen')).toEqual({ ok: true, value: 'stolen' })
    const names = await readdir(join(root, '.devloop'))
    expect(names).not.toContain('outside')
    expect(names.some(name => name.includes('..'))).toBe(false)
  })

  it('treats a .devloop symlink as unarmed and refuses writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-'))
    const outside = await mkdtemp(join(tmpdir(), 'devloop-out-'))
    await symlink(outside, join(root, '.devloop'))
    expect(await workspaceArmed(root)).toBe(false)
    const loaded = await loadState(root, 1)
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.supervisor?.reason).toBe('escaped_devloop')
    await expect(saveState(root, emptyState(0))).rejects.toThrow(/devloop directory/)
    await expect(withStateLock(root, async () => 'no')).rejects.toThrow(/devloop directory/)
  })
})
