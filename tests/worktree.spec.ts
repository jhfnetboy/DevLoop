import { execFile } from 'node:child_process'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { contractForTask } from '../src/router.ts'
import {
  prepareDelegateWorktree,
  worktreePath,
  worktreeTaskToken,
} from '../src/worktree.ts'
import { initGitRepo, makeTask, mkdtempInRepo } from './helpers.ts'

const execFileAsync = promisify(execFile)
const limits = resolveConfig({}).budget

function contractFor(id: string) {
  const task = makeTask({ id, status: 'ready', title: 'Add persist', allowedPaths: ['src/persist.ts'] })
  return contractForTask(
    task.id,
    task.title,
    task.tier,
    task.allowedPaths,
    task.acceptance,
    limits.taskTimeoutMinutes,
    limits.maxTaskAttempts,
  )
}

async function gitWorkspace(): Promise<string> {
  const root = await mkdtempInRepo('devloop-wt-')
  await initGitRepo(root)
  await mkdir(join(root, '.devloop'))
  await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
  return root
}

describe('worktreeTaskToken', () => {
  it('accepts a single path segment and rejects escapes', () => {
    expect(worktreeTaskToken('d1')).toBe('d1')
    expect(worktreeTaskToken('AUTH-001')).toBe('AUTH-001')
    expect(worktreeTaskToken('../etc')).toBeNull()
    expect(worktreeTaskToken('a/b')).toBeNull()
    expect(worktreeTaskToken('')).toBeNull()
    expect(worktreeTaskToken('__proto__')).toBeNull()
    expect(worktreeTaskToken('.hidden')).toBeNull()
    expect(worktreeTaskToken('a..b')).toBeNull()
    expect(worktreeTaskToken('x.lock')).toBeNull()
  })
})

describe('prepareDelegateWorktree', () => {
  it('adds a worktree and writes CONTRACT.json', async () => {
    const root = await gitWorkspace()
    const contract = contractFor('d1')
    const dest = await prepareDelegateWorktree(root, contract)
    expect(dest).toBe(worktreePath(root, 'd1'))
    const raw = await readFile(join(dest, '.devloop', 'CONTRACT.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual(contract)
    await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toContain('# t')
  })

  it('reuses an existing worktree and rewrites the contract', async () => {
    const root = await gitWorkspace()
    const first = await prepareDelegateWorktree(root, contractFor('d1'))
    const updated = { ...contractFor('d1'), title: 'Updated' }
    const second = await prepareDelegateWorktree(root, updated)
    expect(second).toBe(first)
    const raw = await readFile(join(first, '.devloop', 'CONTRACT.json'), 'utf8')
    expect(JSON.parse(raw).title).toBe('Updated')
  })

  it('refuses a destination that already exists and is not a worktree', async () => {
    const root = await gitWorkspace()
    const dest = worktreePath(root, 'd1')
    await mkdir(dest, { recursive: true })
    await expect(prepareDelegateWorktree(root, contractFor('d1'))).rejects.toThrow(/not a git worktree/)
  })

  it('refuses a symlink worktrees/.gitignore', async () => {
    const root = await gitWorkspace()
    const pool = join(root, '.devloop', 'worktrees')
    await mkdir(pool, { recursive: true })
    const evil = join(await mkdtempInRepo('devloop-gi-'), 'outside')
    await writeFile(evil, 'pwned\n', 'utf8')
    await symlink(evil, join(pool, '.gitignore'))
    await expect(prepareDelegateWorktree(root, contractFor('d1'))).rejects.toThrow(/symlink gitignore/)
  })

  it('refuses a registered worktree on the wrong branch', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const root = await gitWorkspace()
    const dest = worktreePath(root, 'd1')
    await execFileAsync('git', ['-C', root, 'worktree', 'add', '-b', 'sneaky', dest])
    await expect(prepareDelegateWorktree(root, contractFor('d1'))).rejects.toThrow(/worktree branch must be/)
  })

  it('refuses a symlink worktrees pool', async () => {
    const root = await gitWorkspace()
    const evil = await mkdtempInRepo('devloop-evil-')
    await symlink(evil, join(root, '.devloop', 'worktrees'))
    await expect(prepareDelegateWorktree(root, contractFor('d1'))).rejects.toThrow(/symlink/)
  })

  it('keeps CONTRACT.json out of a worker git add -A commit', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', '-A'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    const { stdout } = await execFileAsync('git', ['-C', dest, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' })
    expect(stdout).toContain('src.txt')
    expect(stdout).not.toContain('CONTRACT.json')
  })

  it('reattaches a detached worktree HEAD onto the task branch', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await execFileAsync('git', ['-C', dest, 'checkout', '--detach'])
    await expect(prepareDelegateWorktree(root, contractFor('d1'))).resolves.toBe(dest)
    const { stdout } = await execFileAsync('git', ['-C', dest, 'symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' })
    expect(stdout.trim()).toBe('refs/heads/devloop/d1')
  })

  it('throws on an unsafe task id', async () => {
    const root = await gitWorkspace()
    await expect(prepareDelegateWorktree(root, contractFor('../x'))).rejects.toThrow(/unsafe task id/)
  })
})
