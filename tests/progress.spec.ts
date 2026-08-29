import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyUsage } from '../src/budget.ts'
import { emptyState } from '../src/persist.ts'
import { renderProgress, writeProgress } from '../src/progress.ts'

describe('renderProgress', () => {
  it('summarizes an empty loop without claiming tasks', () => {
    const md = renderProgress(emptyState(0), 0)
    expect(md).toContain('lastAction: idle')
    expect(md).toContain('killSwitch: false')
    expect(md).toContain('supervisor: none')
    expect(md).toContain('costUsdSession: 0')
    expect(md).toContain('tasks: 0 (none)')
    expect(md).not.toContain('## Tasks')
  })

  it('lists tasks and a held supervisor', () => {
    const md = renderProgress({
      ...emptyState(0),
      supervisor: { taskId: 't-1', reason: 'empty_task' },
      lastAction: { type: 'escalate', taskId: 't-1', reason: 'empty_task' },
      usage: { ...emptyUsage(0), costUsdSession: 1.25, costUsdDay: 2 },
      tasks: [{
        id: 't-1',
        title: 'Add persist',
        tier: 'T1',
        status: 'ready',
        risk: 'low',
        attempts: 0,
        reviewCycles: 0,
        allowedPaths: ['src/**'],
        acceptance: ['tests pass'],
      }],
    }, 1)
    expect(md).toContain('lastAction: escalate:empty_task')
    expect(md).toContain('supervisor: t-1 empty_task')
    expect(md).toContain('costUsdSession: 1.25')
    expect(md).toContain('tasks: 1 (ready 1)')
    expect(md).toContain('- t-1 ready Add persist')
  })
})

describe('writeProgress', () => {
  it('writes PROGRESS.md under .devloop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-progress-'))
    await mkdir(join(root, '.devloop'))
    await writeProgress(root, emptyState(0), 0)
    const md = await readFile(join(root, '.devloop', 'PROGRESS.md'), 'utf8')
    expect(md).toContain('# DevLoop progress')
    expect(md).toContain('lastAction: idle')
  })

  it('refuses a symlink PROGRESS.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-progress-sym-'))
    await mkdir(join(root, '.devloop'))
    const outside = join(root, 'outside.md')
    await writeFile(outside, 'nope\n', 'utf8')
    await symlink(outside, join(root, '.devloop', 'PROGRESS.md'))
    await expect(writeProgress(root, emptyState(0), 0)).rejects.toThrow(/symlink PROGRESS.md/)
    await expect(readFile(outside, 'utf8')).resolves.toBe('nope\n')
  })

  it('refuses a symlink .devloop directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-progress-dir-'))
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(root, '.devloop'))
    await expect(writeProgress(root, emptyState(0), 0)).rejects.toThrow(/devloop directory must be a real directory/)
  })

  it('replaces a hardlinked PROGRESS.md without writing through the other name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-progress-hard-'))
    await mkdir(join(root, '.devloop'))
    const victim = join(root, 'victim.txt')
    await writeFile(victim, 'keep me\n', 'utf8')
    await link(victim, join(root, '.devloop', 'PROGRESS.md'))
    await writeProgress(root, emptyState(0), 0)
    await expect(readFile(victim, 'utf8')).resolves.toBe('keep me\n')
    const md = await readFile(join(root, '.devloop', 'PROGRESS.md'), 'utf8')
    expect(md).toContain('# DevLoop progress')
    expect(md).toContain('lastAction: idle')
  })
})
