import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { emptyState, loadState, saveState, workspaceArmed } from '../src/persist.ts'
import { runTick } from '../src/tick.ts'
import type { Task } from '../src/types.ts'

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

  it('increments delegate attempts on a recorded tick', () => {
    const task: Task = {
      id: 't-1',
      title: 'crud',
      tier: 'T1',
      status: 'ready',
      risk: 'low',
      attempts: 0,
      reviewCycles: 0,
      allowedPaths: ['src/**'],
      acceptance: ['tests pass'],
    }
    const seeded = { ...emptyState(0), tasks: [task] }
    const result = runTick(seeded, resolveConfig({}).budget, 10)
    expect(result.action).toEqual({ type: 'delegate', taskId: 't-1' })
    expect(result.state.usage.taskAttempts['t-1']).toBe(1)
    expect(result.state.usage.taskStartedAt['t-1']).toBe(10)
  })

  it('stops on budget instead of delegating forever', () => {
    const task: Task = {
      id: 't-1',
      title: 'crud',
      tier: 'T1',
      status: 'ready',
      risk: 'low',
      attempts: 0,
      reviewCycles: 0,
      allowedPaths: ['src/**'],
      acceptance: ['tests pass'],
    }
    const state = emptyState(0)
    const blown = {
      ...state,
      tasks: [task],
      usage: { ...state.usage, taskAttempts: { 't-1': 3 } },
    }
    const result = runTick(blown, resolveConfig({}).budget, 10)
    expect(result.action).toEqual({ type: 'stop', reason: 'budget' })
    expect(result.state.supervisor?.reason).toBe('max_task_attempts:t-1')
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
})
