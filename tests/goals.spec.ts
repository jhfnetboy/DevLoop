import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { goalNumber, nextGoalState, startNextGoal } from '../src/goals.ts'
import { decideNextAction } from '../src/loop.ts'
import { OperatorError } from '../src/operator.ts'
import { loadState, saveState } from '../src/persist.ts'
import type { LoopState } from '../src/types.ts'
import { baseState, makeTask, mkdtempInRepo, withTasks } from './helpers.ts'

const NOW = Date.parse('2026-09-13T08:00:00Z')

function finished(overrides: Partial<LoopState> = {}): LoopState {
  const state = withTasks(baseState(), [makeTask({ id: 'T1', status: 'done', lastReviewVerdict: 'PASS' })])
  return {
    ...state,
    goalCompleted: true,
    killSwitch: true,
    lastAction: { type: 'stop', reason: 'goal_complete' },
    workBranch: 'work',
    usage: { ...state.usage, taskAttempts: { T1: 2 }, reviewCycles: { T1: 1 }, tokens: { T1: 900 }, costUsdDay: 1.5, costUsdSession: 0.7, lastActions: ['review:T1'] },
    ...overrides,
  }
}

describe('the next goal on the same repository', () => {
  it('starts from where the finished one left off, with its own task counters and the spend carried over', () => {
    const next = nextGoalState(finished({ release: { number: 5, merged: true } }), NOW, true)
    expect(next).toMatchObject({ goal: { number: 2, startedAt: '2026-09-13T08:00:00.000Z' }, goalCompleted: false, killSwitch: false, supervisor: null, tasks: [], workBranch: 'work' })
    const { taskAttempts, reviewCycles, tokens, refusedDispatches, taskStartedAt } = next.usage
    expect({ taskAttempts, reviewCycles, tokens, refusedDispatches, taskStartedAt }).toEqual({ taskAttempts: {}, reviewCycles: {}, tokens: {}, refusedDispatches: {}, taskStartedAt: {} })
    expect(next.usage).toMatchObject({ lastActions: [], lastProgressAt: NOW, costUsdDay: 1.5, costUsdSession: 0.7 })
    expect('release' in next).toBe(false)
    // The loop plans the new goal on its next tick.
    expect(decideNextAction(next)).toEqual({ type: 'plan' })
    expect(goalNumber(nextGoalState({ ...next, goalCompleted: true, tasks: [makeTask({ id: 'g2-T1', status: 'done' })] }, NOW, false))).toBe(3)
  })

  it('refuses while the goal is unfinished, held, running, or its release has not merged', () => {
    expect(() => nextGoalState(finished({ goalCompleted: false }), NOW, false)).toThrow(/not finished/)
    expect(() => nextGoalState(finished({ supervisor: { taskId: 'T1', reason: 'merge_wedged' } }), NOW, false)).toThrow(/held/)
    expect(() => nextGoalState(finished({ tasks: [makeTask({ id: 'T1', status: 'merge_ready' })] }), NOW, false)).toThrow(/not every task is done/)
    const running = finished()
    expect(() => nextGoalState({ ...running, usage: { ...running.usage, parallelWorkers: 1 } }, NOW, false)).toThrow(/still running/)
    // On the forge the next release must carry only the next goal's work.
    for (const release of [undefined, { number: 5, merged: false }] as const) {
      expect(() => nextGoalState(finished(release ? { release } : {}), NOW, true)).toThrow(/release pull request has not merged/)
    }
    expect(() => nextGoalState(finished(), NOW, false)).not.toThrow()
  })

  it('archives the finished goal under .devloop/archive, writes the new one, and saves STATE last', async () => {
    const root = await mkdtempInRepo('devloop-goals-')
    const dir = join(root, '.devloop')
    await mkdir(dir)
    const saved = await saveState(root, finished())
    await writeFile(join(dir, 'GOAL.md'), '# Goal one\n', 'utf8')
    await writeFile(join(dir, 'PLAN.md'), 'plan one\n', 'utf8')
    await writeFile(join(dir, 'REVIEW.md'), 'review one\n', 'utf8')

    const next = await startNextGoal(root, '  # Goal two  ', { expectedRevision: saved.revision, requireRelease: false, via: 'dashboard', now: () => NOW })
    expect(next).toMatchObject({ goal: { number: 2 }, revision: saved.revision + 1, goalCompleted: false })
    expect((await loadState(root, NOW)).goal?.number).toBe(2)
    expect(await readFile(join(dir, 'GOAL.md'), 'utf8')).toBe('# Goal two\n')
    const archived = join(dir, 'archive', '0001')
    expect((await readdir(archived)).sort()).toEqual(['GOAL.md', 'PLAN.md', 'REVIEW.md', 'STATE.json'])
    expect(await readFile(join(archived, 'GOAL.md'), 'utf8')).toBe('# Goal one\n')
    expect(JSON.parse(await readFile(join(archived, 'STATE.json'), 'utf8'))).toMatchObject({ goalCompleted: true, revision: saved.revision })
    // The next goal writes its own plan and review; the old ones are only in the archive.
    expect((await readdir(dir)).filter(name => name === 'PLAN.md' || name === 'REVIEW.md')).toEqual([])

    // Unfinished now, so a second call is refused; a stale page is refused before anything moves.
    await expect(startNextGoal(root, 'three', { requireRelease: false, via: 'cli' })).rejects.toMatchObject({ code: 'refused' })
    await expect(startNextGoal(root, 'three', { expectedRevision: saved.revision, requireRelease: false, via: 'cli' })).rejects.toMatchObject({ code: 'stale' })
    await expect(startNextGoal(root, '   ', { requireRelease: false, via: 'cli' })).rejects.toBeInstanceOf(OperatorError)
  })

  it('reads back a goal mark only when it is one a handover could have written', async () => {
    const root = await mkdtempInRepo('devloop-goals-')
    await mkdir(join(root, '.devloop'))
    const saved = await saveState(root, { ...finished(), goal: { number: 2, startedAt: '2026-09-13T08:00:00.000Z' } })
    expect((await loadState(root, NOW)).goal).toEqual({ number: 2, startedAt: '2026-09-13T08:00:00.000Z' })
    for (const goal of [{ number: 1, startedAt: 'x' }, { number: 2.5, startedAt: 'x' }, { number: 2, startedAt: '' }, { number: '2' }]) {
      await writeFile(join(root, '.devloop', 'STATE.json'), JSON.stringify({ ...saved, goal }), 'utf8')
      // Not taken as written: the journal's last good state is read back instead.
      expect((await loadState(root, NOW)).goal, JSON.stringify(goal)).toEqual({ number: 2, startedAt: '2026-09-13T08:00:00.000Z' })
    }
  })

  it('goes on from an archive a stopped call already wrote, and writes each goal to its own', async () => {
    const root = await mkdtempInRepo('devloop-goals-')
    const dir = join(root, '.devloop')
    await mkdir(join(dir, 'archive', '0001'), { recursive: true })
    await writeFile(join(dir, 'archive', '0001', 'GOAL.md'), '# Goal one\n', 'utf8')
    await saveState(root, finished())
    await writeFile(join(dir, 'GOAL.md'), '# Goal two\n', 'utf8')
    await startNextGoal(root, '# Goal two', { requireRelease: false, via: 'cli', now: () => NOW })
    expect(await readFile(join(dir, 'archive', '0001', 'GOAL.md'), 'utf8')).toBe('# Goal one\n')

    const second = await loadState(root, NOW)
    await saveState(root, { ...second, goalCompleted: true, tasks: [makeTask({ id: 'g2-T1', status: 'done' })] })
    await startNextGoal(root, '# Goal three', { requireRelease: false, via: 'cli', now: () => NOW })
    expect(await readFile(join(dir, 'archive', '0002', 'GOAL.md'), 'utf8')).toBe('# Goal two\n')
    expect((await loadState(root, NOW)).goal?.number).toBe(3)
  })
})
