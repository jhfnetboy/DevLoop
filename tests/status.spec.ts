import { execFile } from 'node:child_process'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { scanRepo } from '../src/status.ts'
import { initWorkRepo, mkdtempInRepo } from './helpers.ts'

const git = (root: string, ...args: string[]) => promisify(execFile)('git', ['-C', root, ...args])

async function commitOn(root: string, branch: string, file: string): Promise<void> {
  await git(root, 'switch', '-q', '-c', branch)
  await writeFile(join(root, file), `${branch}\n`, 'utf8')
  await git(root, 'add', file)
  await git(root, 'commit', '-q', '-m', branch)
}

describe('scanning a repository', () => {
  it('counts ahead and behind against the remote\'s trunk when there is one, not a local trunk nobody pulled', async () => {
    const upstream = await realpath(await mkdtempInRepo('status-up-'))
    await initWorkRepo(upstream)
    await git(upstream, 'switch', '-q', 'main')
    const root = await realpath(await mkdtempInRepo('status-clone-'))
    await git(root, 'clone', '-q', upstream, '.')
    await git(root, 'switch', '-q', '-c', 'feature')
    await commitOn(upstream, 'extra', 'u.txt')
    await git(upstream, 'switch', '-q', 'main')
    await git(upstream, 'merge', '-q', '--no-edit', 'extra')
    await git(root, 'fetch', '-q', 'origin')
    // Local main still where the clone left it; origin/main one commit ahead of this branch.
    const s = await scanRepo(root)
    expect({ ahead: s.ahead, behind: s.behind }).toEqual({ ahead: 0, behind: 1 })
    // No remote trunk at all: the local one, as before.
    expect((await scanRepo(upstream)).behind).not.toBeNull()
  })


  it('marks what branch -d would take, and every reason a branch is kept', async () => {
    const root = await realpath(await mkdtempInRepo('status-scan-'))
    await initWorkRepo(root)
    await commitOn(root, 'feature/done', 'a.txt')
    await git(root, 'switch', '-q', 'work')
    await git(root, 'merge', '-q', '--no-edit', 'feature/done')
    await commitOn(root, 'feature/open', 'b.txt') // unmerged
    await git(root, 'switch', '-q', 'work')
    await git(root, 'branch', 'release/1.0')
    await git(root, 'branch', 'devloop/T1')
    await git(root, 'branch', 'parked')
    // Tags named like the trunk and the current branch: none of the three git reads may see heads/<x>.
    await git(root, 'tag', 'main')
    await git(root, 'tag', 'work')
    await git(root, 'worktree', 'add', '-q', join(root, '.devloop-wt'), 'parked')
    await writeFile(join(root, '.devloop-wt', 'scratch.txt'), 'x\n', 'utf8')

    const s = await scanRepo(root, { activeBranches: new Set(['devloop/T1']) })
    const by = Object.fromEntries(s.branches.map(b => [b.name, b]))
    expect(s.branch).toBe('work')
    expect(s.base).toBe('main')
    expect(by['feature/done']).toEqual({ name: 'feature/done', merged: true, protectedBy: null })
    expect(by['feature/open']).toMatchObject({ merged: false, protectedBy: null })
    expect(by.work?.protectedBy).toBe('current')
    expect(by.main).toEqual({ name: 'main', merged: true, protectedBy: 'trunk' })
    expect(by['release/1.0']?.protectedBy).toBe('pattern')
    expect(by.parked?.protectedBy).toBe('worktree')
    expect(by['devloop/T1']?.protectedBy).toBe('active_task')
    expect(s.worktrees.find(w => w.branch === 'parked')?.dirty).toBe(true)
    expect(s.ahead).toBe(1) // the feature commit, fast-forwarded into work
    expect(s.behind).toBe(0)
    expect(s.protectDropped).toEqual([]) // no .pilot.yml: the floor, nothing dropped
  })

  it('never offers the current branch when HEAD names it in another case', async (context) => {
    const root = await realpath(await mkdtempInRepo('status-case-'))
    await initWorkRepo(root)
    await git(root, 'branch', 'feature')
    // Only where `Feature` resolves to the loose `feature` ref (macOS by default).
    if (!await git(root, 'switch', '-q', 'Feature').then(() => true, () => false)) context.skip()
    const s = await scanRepo(root)
    expect(s.branch).toBe('Feature')
    expect(s.branches.find(b => b.name === 'feature')?.protectedBy).toBe('current')
  })

  it('reports a detached HEAD and leaves ahead/behind unknown without a base branch', async () => {
    const root = await realpath(await mkdtempInRepo('status-detached-'))
    await initWorkRepo(root)
    await git(root, 'branch', '-q', '-m', 'main', 'trunk-renamed')
    await git(root, 'switch', '-q', '--detach')
    const s = await scanRepo(root)
    expect(s.branch).toBeNull()
    expect(s.ahead).toBeNull()
  })
})

describe('scanning only a repository of its own', () => {
  it('refuses a root git would resolve to an enclosing repository', async () => {
    const outer = await realpath(await mkdtempInRepo('status-outer-'))
    await initWorkRepo(outer)
    await promisify(execFile)('rm', ['-rf', join(outer, '.git')]) // inside this checkout: git would answer for DevLoop
    await expect(scanRepo(outer)).rejects.toThrow(/toplevel/)
  })
})
