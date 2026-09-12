import { execFile } from 'node:child_process'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { applyCleanup, planCleanup, refusal, refusalReason } from '../src/cleanup.ts'
import { scanRepo } from '../src/status.ts'
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
      { name: 'devloop/a$b', merged: false, protectedBy: null },
    ], [
      { path: '/r', branch: null, dirty: false, primary: true, current: false }, // detached: known by position, not branch
      { path: '/r/.devloop/worktrees/T1', branch: 'devloop/T1', dirty: false, primary: false, current: false },
      { path: '/here', branch: 'here', dirty: false, primary: false, current: true }, // the project's own checkout
      { path: '/tmp/side', branch: 'side', dirty: false, primary: false, current: false },
      { path: '/tmp/wip', branch: 'wip', dirty: true, primary: false, current: false },
    ]))
    expect(plan.delete).toEqual(['done'])
    expect(plan.keep.map(k => k.name)).toEqual(['work', 'release/1', 'open', 'devloop/T9', 'devloop/a$b'])
    // Each reason also as a code, for a page to say in its reader's language.
    expect(plan.keep.map(k => k.code)).toEqual(['current', 'pattern', 'unmerged', 'unmerged', 'unmerged'])
    expect(plan.manual.map(m => m.code)).toEqual(['unmergedTask', 'unmergedTask', 'cleanWorktree', 'dirtyWorktree'])
    // Never run here: -D for an abandoned task branch, worktree removal, a look at a dirty one.
    expect(plan.manual.map(m => m.command)).toEqual([
      'git branch -D -- devloop/T9',
      "git branch -D -- 'devloop/a$b'",
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
    // None of them was on offer at the moment of acting: one code, whatever made it so.
    expect(result.refused.map(r => r.code)).toEqual(['notOffered', 'notOffered', 'notOffered'])
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
    expect(result.refused).toEqual([{ name: 'guarded', code: 'gitRefused', reason: 'git 拒绝删除这个分支' }])
    expect((await git(root, 'rev-parse', '--verify', 'refs/heads/guarded')).stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('never offers to remove the project\'s own checkout or the main one, when the project is a linked worktree', async () => {
    const main = await realpath(await mkdtempInRepo('cleanup-linked-'))
    await initWorkRepo(main)
    const linked = join(main, '..', `${main.split('/').pop()}-linked`)
    await git(main, 'worktree', 'add', '-q', '-b', 'lw', linked)
    await git(main, 'worktree', 'add', '-q', '-b', 'spare', `${linked}-spare`)
    const s = await scanRepo(await realpath(linked))
    expect(s.worktrees.map(w => [w.primary, w.current])).toEqual([[true, false], [false, true], [false, false]])
    const removals = planCleanup(s).manual.map(m => m.command).filter(c => c.startsWith('git worktree remove'))
    expect(removals).toEqual([`git worktree remove ${await realpath(`${linked}-spare`)}`])
  })

  it('deletes only with -d: a branch merged into HEAD but not into its upstream is kept', async () => {
    const root = await realpath(await mkdtempInRepo('cleanup-upstream-'))
    await initWorkRepo(root)
    await writeFile(join(root, 'y.txt'), 'y\n', 'utf8')
    await git(root, 'add', 'y.txt')
    await git(root, 'commit', '-q', '-m', 'y')
    await git(root, 'branch', 'featA') // merged into HEAD (work)…
    await git(root, 'branch', '--set-upstream-to=main', 'featA') // …but its upstream lacks the commit
    const result = await applyCleanup(root, ['featA'])
    expect(result.deleted).toEqual([]) // -D would have deleted it
    expect(result.refused).toEqual([{ name: 'featA', code: 'notMerged', reason: 'git 拒绝：分支没有完全合并' }])
    expect((await git(root, 'rev-parse', '--verify', 'refs/heads/featA')).stdout).toBeTruthy()
  })

  it('maps every git refusal to our own words, never its stderr or a path', () => {
    const leak = '/Users/someone/repo'
    const cases: [string, string, string][] = [
      [`error: the branch 'x' is not fully merged\nhint: run 'git branch -D x' in ${leak}`, 'git 拒绝：分支没有完全合并', 'notMerged'],
      [`error: cannot delete branch 'x' used by worktree at '${leak}'`, 'git 拒绝：分支被某个 worktree 检出', 'checkedOut'],
      [`fatal: something else in ${leak}`, 'git 拒绝删除这个分支', 'gitRefused'],
    ]
    for (const [stderr, reason, code] of cases) {
      const error = Object.assign(new Error(`Command failed: git -C ${leak} branch -d -- x`), { stderr })
      const said = refusalReason(error)
      expect(said).toBe(reason)
      expect(refusal(error)).toEqual({ code, reason })
      expect(said).not.toContain(leak)
      expect(said).not.toMatch(/error:|fatal:|hint:/)
    }
  })

  it('reads the repository it was given even when GIT_DIR points elsewhere', async () => {
    const root = await realpath(await mkdtempInRepo('cleanup-env-'))
    await initWorkRepo(root)
    await git(root, 'branch', 'only-here')
    const other = await realpath(await mkdtempInRepo('cleanup-env-other-'))
    await initWorkRepo(other)
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = join(other, '.git')
    try {
      expect((await scanRepo(root)).branches.map(b => b.name)).toContain('only-here')
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
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
