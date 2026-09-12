import { execFile } from 'node:child_process'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { applyCleanup, planCleanup } from '../src/cleanup.ts'
import type { RepoStatus } from '../src/status.ts'
import { initWorkRepo, mkdtempInRepo } from './helpers.ts'

const git = (root: string, ...args: string[]) => promisify(execFile)('git', ['-C', root, ...args])

const status = (branches: RepoStatus['branches'], worktrees: RepoStatus['worktrees'] = []): RepoStatus =>
  ({ branch: 'work', base: 'main', trackedChanges: 0, ahead: 0, behind: 0, branches, worktrees, protectDropped: [] })

describe('planning a cleanup', () => {
  it('offers only merged, unprotected branches, and lists the rest with a reason', () => {
    const plan = planCleanup(status([
      { name: 'done', merged: true, protectedBy: null },
      { name: 'work', merged: true, protectedBy: 'current' },
      { name: 'release/1', merged: true, protectedBy: 'pattern' },
      { name: 'open', merged: false, protectedBy: null },
      { name: 'devloop/T9', merged: false, protectedBy: null },
    ], [
      { path: '/r', branch: 'work', dirty: false },
      { path: '/r/.devloop/worktrees/T1', branch: 'devloop/T1', dirty: false },
      { path: '/tmp/side', branch: 'side', dirty: false },
      { path: '/tmp/wip', branch: 'wip', dirty: true },
    ]))
    expect(plan.delete).toEqual(['done'])
    expect(plan.keep.map(k => k.name)).toEqual(['work', 'release/1', 'open', 'devloop/T9'])
    // Never run here: -D for an abandoned task branch, worktree removal, a look at a dirty one.
    expect(plan.manual.map(m => m.command)).toEqual([
      'git branch -D devloop/T9',
      'git worktree remove /tmp/side',
      'git -C /tmp/wip status',
    ])
  })
})

describe('applying a cleanup', () => {
  it('deletes what is confirmed and still safe, and refuses the rest without touching it', async () => {
    const root = await realpath(await mkdtempInRepo('cleanup-apply-'))
    await initWorkRepo(root)
    await git(root, 'branch', 'merged-a')
    await git(root, 'branch', 'release/2')
    await git(root, 'switch', '-q', '-c', 'moved')
    await writeFile(join(root, 'x.txt'), 'x\n', 'utf8')
    await git(root, 'add', 'x.txt')
    await git(root, 'commit', '-q', '-m', 'x') // no longer merged into work
    await git(root, 'switch', '-q', 'work')

    const result = await applyCleanup(root, ['merged-a', 'release/2', 'moved', 'work', 'merged-a'])
    expect(result.deleted).toEqual(['merged-a'])
    expect(result.refused.map(r => r.name)).toEqual(['release/2', 'moved', 'work'])
    // Reasons are ours, never git's raw message with its command line and paths.
    for (const r of result.refused) expect(r.reason).not.toContain(root)
    const left = (await git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).stdout
    expect(left.split('\n').filter(Boolean).sort()).toEqual(['main', 'moved', 'release/2', 'work'])
  })

  it('runs the repository\'s own ref hook, and reports its refusal without git\'s raw message', async () => {
    const root = await realpath(await mkdtempInRepo('cleanup-hook-'))
    await initWorkRepo(root)
    await git(root, 'branch', 'guarded')
    const hooks = (await git(root, 'rev-parse', '--git-path', 'hooks')).stdout.trim()
    await promisify(execFile)('mkdir', ['-p', join(root, hooks)])
    // Like pilot's guard: refuse every branch deletion.
    await writeFile(join(root, hooks, 'reference-transaction'), '#!/bin/sh\n[ "$1" = prepared ] && grep -q "^[0-9a-f]* 0\\{40\\} refs/heads/" && exit 1\nexit 0\n', { mode: 0o755 })
    const result = await applyCleanup(root, ['guarded'])
    expect(result.deleted).toEqual([])
    expect(result.refused).toEqual([{ name: 'guarded', reason: 'git 拒绝删除这个分支' }])
    expect((await git(root, 'rev-parse', '--verify', 'refs/heads/guarded')).stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('keeps an active task branch even when it is merged and confirmed', async () => {
    const root = await realpath(await mkdtempInRepo('cleanup-active-'))
    await initWorkRepo(root)
    await git(root, 'branch', 'devloop/T1')
    const result = await applyCleanup(root, ['devloop/T1'], { activeBranches: new Set(['devloop/T1']) })
    expect(result.deleted).toEqual([])
    expect(result.refused[0]?.name).toBe('devloop/T1')
  })
})
