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
