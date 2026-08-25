import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { emptyState, loadState, saveState, workspaceArmed } from '../src/persist.ts'
import { runTick } from '../src/tick.ts'
import { makeTask, setStatus } from './helpers.ts'

/**
 * Full 0.1 operator flow: the program only records the next action.
 * A human (or later worker adapter) advances task status between ticks.
 */
describe('0.1 full pipeline flow', () => {
  const limits = resolveConfig({}).budget

  it('walks plan → delegate → review → merge → done → stop on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-flow-'))
    await mkdir(join(root, '.devloop'))
    expect(await workspaceArmed(root)).toBe(false)
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n\nBuild the loop.\n', 'utf8')
    expect(await workspaceArmed(root)).toBe(true)

    let beat = runTick(emptyState(0), limits, 10)
    expect(beat.action).toEqual({ type: 'plan' })
    await saveState(root, beat.state)

    beat = runTick(await loadState(root, 20), limits, 20)
    expect(beat.skipped).toBe(true)
    expect((await loadState(root, 20)).lastAction).toEqual({ type: 'plan' })

    const planned = await loadState(root, 30)
    const tasked = {
      ...planned,
      tasks: [makeTask({ id: 'AUTH-001', status: 'ready', title: 'schema' })],
    }
    beat = runTick(tasked, limits, 30)
    expect(beat.action).toEqual({ type: 'delegate', taskId: 'AUTH-001' })
    expect(beat.state.usage.taskAttempts['AUTH-001']).toBe(1)
    await saveState(root, beat.state)

    beat = runTick(setStatus(beat.state, 'AUTH-001', 'running'), limits, 40)
    expect(beat.skipped).toBe(true)

    beat = runTick(setStatus(beat.state, 'AUTH-001', 'review_pending'), limits, 50)
    expect(beat.skipped).toBe(false)
    expect(beat.action).toEqual({ type: 'review', taskId: 'AUTH-001' })
    expect(beat.state.usage.reviewCycles['AUTH-001']).toBe(1)
    await saveState(root, beat.state)

    beat = runTick(setStatus(beat.state, 'AUTH-001', 'merge_ready'), limits, 60)
    expect(beat.action).toEqual({ type: 'merge', taskId: 'AUTH-001' })
    await saveState(root, beat.state)

    beat = runTick(setStatus(beat.state, 'AUTH-001', 'done'), limits, 70)
    expect(beat.action).toEqual({ type: 'stop', reason: 'goal_complete' })
    expect(beat.state.killSwitch).toBe(true)
    await saveState(root, beat.state)

    beat = runTick(await loadState(root, 80), limits, 80)
    expect(beat.skipped).toBe(true)
    const frozen = await loadState(root, 80)
    expect(frozen.lastAction).toEqual({ type: 'stop', reason: 'goal_complete' })
    const raw = await readFile(join(root, '.devloop', 'GOAL.md'), 'utf8')
    expect(raw).toContain('Build the loop')
  })

  it('unlatches rework after a failed review and retries delegate', () => {
    const first = runTick({
      ...emptyState(0),
      tasks: [makeTask({ id: 'AUTH-001', status: 'ready' })],
    }, limits, 10)
    const pending = runTick(setStatus(first.state, 'AUTH-001', 'review_pending'), limits, 20)
    expect(pending.action).toEqual({ type: 'review', taskId: 'AUTH-001' })
    const retry = runTick(setStatus(pending.state, 'AUTH-001', 'rework'), limits, 30)
    expect(retry.skipped).toBe(false)
    expect(retry.action).toEqual({ type: 'delegate', taskId: 'AUTH-001' })
    expect(retry.state.usage.taskAttempts['AUTH-001']).toBe(2)
  })

  it('halts on disk when attempts are exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-halt-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    const blown = {
      ...emptyState(0),
      tasks: [makeTask({ id: 'AUTH-001', status: 'ready' })],
      usage: { ...emptyState(0).usage, taskAttempts: { 'AUTH-001': 3 } },
    }
    const beat = runTick(blown, limits, 10)
    expect(beat.action).toEqual({ type: 'stop', reason: 'budget' })
    await saveState(root, beat.state)
    const frozen = await loadState(root, 20)
    expect(frozen.killSwitch).toBe(true)
    expect(runTick(frozen, limits, 20).skipped).toBe(true)
  })

  it('priority: review beats merge beats delegate beats plan', () => {
    const mixed = {
      ...emptyState(0),
      tasks: [
        makeTask({ id: 'p', status: 'ready' }),
        makeTask({ id: 'm', status: 'merge_ready' }),
        makeTask({ id: 'r', status: 'review_pending' }),
      ],
    }
    expect(runTick(mixed, limits, 1).action).toEqual({ type: 'review', taskId: 'r' })
    const afterReview = {
      ...mixed,
      tasks: mixed.tasks.filter(task => task.id !== 'r'),
    }
    expect(runTick(afterReview, limits, 2).action).toEqual({ type: 'merge', taskId: 'm' })
  })
})
