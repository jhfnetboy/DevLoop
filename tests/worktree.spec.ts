import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { contractForTask } from '../src/router.ts'
import {
  mergeTaskWorktree,
  deleteMergedTaskBranch,
  taskCommitMessage,
  prepareDelegateWorktree,
  preparePlanWorktree,
  removePlanWorktree,
  commitDirtyTaskWorktree,
  PLAN_WORKTREE_ID,
  WORKTREE_BRANCH_PREFIX,
  planWorktreePath,
  readContractBaseSha,
  worktreePath,
  worktreeTaskToken,
  assertTaskChangesAllowed,
  taskWorktreeHeadSha,
  fastForwardWorkBranch,
} from '../src/worktree.ts'
import { initGitRepo, makeTask, mkdtempInRepo } from './helpers.ts'

const execFileAsync = promisify(execFile)
const limits = resolveConfig({}).budget
const scratch: string[] = []

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
  scratch.push(root)
  await initGitRepo(root)
  await mkdir(join(root, '.devloop'))
  await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
  return root
}

afterEach(async () => {
  const dirs = scratch.splice(0)
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

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
    expect(worktreeTaskToken(PLAN_WORKTREE_ID)).toBeNull()
    expect(worktreeTaskToken('LOOP-PLAN')).toBe('LOOP-PLAN')
    expect(worktreeTaskToken('_loop-plan')).toBeNull()
  })
})

describe('prepareDelegateWorktree', () => {
  it('adds a worktree and writes CONTRACT.json', async () => {
    const root = await gitWorkspace()
    const contract = contractFor('d1')
    const dest = await prepareDelegateWorktree(root, contract)
    expect(dest).toBe(worktreePath(root, 'd1'))
    const raw = await readFile(join(dest, '.devloop', 'CONTRACT.json'), 'utf8')
    const parsed = JSON.parse(raw) as { taskId: string; baseSha: string }
    expect(parsed).toEqual({ ...contract, baseSha: parsed.baseSha })
    expect(parsed.baseSha).toMatch(/^[0-9a-f]{40}$/)
    await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toContain('# t')
  })

  it('reuses an existing worktree and rewrites the contract', async () => {
    const root = await gitWorkspace()
    const first = await prepareDelegateWorktree(root, contractFor('d1'))
    const firstSha = JSON.parse(await readFile(join(first, '.devloop', 'CONTRACT.json'), 'utf8')).baseSha as string
    const updated = { ...contractFor('d1'), title: 'Updated' }
    const second = await prepareDelegateWorktree(root, updated)
    expect(second).toBe(first)
    const parsed = JSON.parse(await readFile(join(first, '.devloop', 'CONTRACT.json'), 'utf8')) as { title: string; baseSha: string }
    expect(parsed.title).toBe('Updated')
    expect(parsed.baseSha).toBe(firstSha)
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
    const gi = await mkdtempInRepo('devloop-gi-')
    scratch.push(gi)
    const evil = join(gi, 'outside')
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
    scratch.push(evil)
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

  it('commits dirty task files from the host process', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'worker\n', 'utf8')
    await commitDirtyTaskWorktree(dest, 'd1', 'Add the\nsrc file')
    const { stdout } = await execFileAsync('git', ['-C', dest, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' })
    expect(stdout).toContain('src.txt')
    expect(stdout).not.toContain('CONTRACT.json')
    // Named for its task, on one line: history says which task made which change.
    const { stdout: log } = await execFileAsync('git', ['-C', dest, 'log', '-1', '--pretty=%B'], { encoding: 'utf8' })
    expect(log.trim()).toBe('d1: Add the src file')
  })

  it('host commit does not run worktree-configured hooks', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    const hookDir = join(dest, '.delegate-hooks')
    await mkdir(hookDir)
    const hook = join(hookDir, 'pre-commit')
    await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8')
    await chmod(hook, 0o755)
    await execFileAsync('git', ['-C', dest, 'config', 'core.hooksPath', '.delegate-hooks'])
    await writeFile(join(dest, 'src.txt'), 'worker\n', 'utf8')
    await commitDirtyTaskWorktree(dest, 'd1')
    const { stdout: log } = await execFileAsync('git', ['-C', dest, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' })
    expect(log.trim()).toBe('d1: DevLoop task')
  })

  it('refuses a host commit when HEAD is not the task branch', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await execFileAsync('git', ['-C', dest, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    await writeFile(join(dest, 'src.txt'), 'worker\n', 'utf8')
    await expect(commitDirtyTaskWorktree(dest, 'd1')).rejects.toThrow(/HEAD is not refs\/heads\/devloop\/d1/)
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

  it('refuses the reserved plan worktree id', async () => {
    const root = await gitWorkspace()
    await expect(prepareDelegateWorktree(root, contractFor(PLAN_WORKTREE_ID))).rejects.toThrow(/unsafe task id/)
    await expect(mergeTaskWorktree(root, PLAN_WORKTREE_ID, '0'.repeat(40))).rejects.toThrow(/unsafe task id/)
  })
})

describe('preparePlanWorktree', () => {
  it('copies GOAL.md into a reserved plan worktree', async () => {
    const root = await gitWorkspace()
    const dest = await preparePlanWorktree(root)
    expect(dest).toBe(planWorktreePath(root))
    await expect(readFile(join(dest, '.devloop', 'GOAL.md'), 'utf8')).resolves.toBe('# Goal\n')
  })

  it('does not share a path or branch with a LOOP-PLAN user task', async () => {
    const root = await gitWorkspace()
    const taskDest = await prepareDelegateWorktree(root, contractFor('LOOP-PLAN'))
    const planDest = await preparePlanWorktree(root)
    expect(planDest).not.toBe(taskDest)
    expect(planDest.toLowerCase()).not.toBe(taskDest.toLowerCase())
  }, 30_000)

  it('resets a reused plan worktree to the current workspace HEAD and can drop it', async () => {
    const root = await gitWorkspace()
    const first = await preparePlanWorktree(root)
    await writeFile(join(root, 'file.txt'), 'v2\n', 'utf8')
    await execFileAsync('git', ['-C', root, 'add', 'file.txt'])
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'v2'])
    const second = await preparePlanWorktree(root)
    expect(second).toBe(first)
    await expect(readFile(join(second, 'file.txt'), 'utf8')).resolves.toBe('v2\n')
    await removePlanWorktree(root)
    await expect(lstat(first)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('removes a partial plan worktree if GOAL.md is missing', async () => {
    const root = await gitWorkspace()
    await rm(join(root, '.devloop', 'GOAL.md'))
    await expect(preparePlanWorktree(root)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(planWorktreePath(root))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not reset or delete an existing devloop/_loop-plan branch', async () => {
    const root = await gitWorkspace()
    await writeFile(join(root, 'keep.txt'), 'keep\n', 'utf8')
    await execFileAsync('git', ['-C', root, 'add', 'keep.txt'])
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'keep'])
    await execFileAsync('git', ['-C', root, 'branch', `${WORKTREE_BRANCH_PREFIX}${PLAN_WORKTREE_ID}`])
    const { stdout: before } = await execFileAsync('git', ['-C', root, 'rev-parse', `${WORKTREE_BRANCH_PREFIX}${PLAN_WORKTREE_ID}`], { encoding: 'utf8' })
    await preparePlanWorktree(root)
    await removePlanWorktree(root)
    const { stdout: after } = await execFileAsync('git', ['-C', root, 'rev-parse', `${WORKTREE_BRANCH_PREFIX}${PLAN_WORKTREE_ID}`], { encoding: 'utf8' })
    expect(after.trim()).toBe(before.trim())
  })

  it('refuses a symlink _loop-plan that aliases another task worktree', async () => {
    const root = await gitWorkspace()
    const taskDest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(taskDest, 'keep.txt'), 'uncommitted\n', 'utf8')
    await symlink(taskDest, planWorktreePath(root))
    await expect(preparePlanWorktree(root)).rejects.toThrow(/symlink plan worktree/)
    await expect(readFile(join(taskDest, 'keep.txt'), 'utf8')).resolves.toBe('uncommitted\n')
    expect((await lstat(taskDest)).isDirectory()).toBe(true)
  }, 30_000)

  it('does not follow a destination GOAL.md symlink when reusing the plan worktree', async () => {
    const root = await gitWorkspace()
    const dest = await preparePlanWorktree(root)
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'keep\n', 'utf8')
    const destGoal = join(dest, '.devloop', 'GOAL.md')
    await rm(destGoal)
    await symlink(outside, destGoal)
    await preparePlanWorktree(root)
    await expect(readFile(outside, 'utf8')).resolves.toBe('keep\n')
    await expect(readFile(destGoal, 'utf8')).resolves.toBe('# Goal\n')
    expect((await lstat(destGoal)).isSymbolicLink()).toBe(false)
  }, 30_000)

  it('prunes a stale git worktree registration when the directory is already gone', async () => {
    const root = await gitWorkspace()
    const dest = await preparePlanWorktree(root)
    await rm(dest, { recursive: true, force: true })
    await removePlanWorktree(root)
    const again = await preparePlanWorktree(root)
    expect(again).toBe(planWorktreePath(root))
    await removePlanWorktree(root)
  }, 30_000)
})

describe('taskCommitMessage', () => {
  it('is the task id and its title on one line, cut to fit a log', () => {
    expect(taskCommitMessage('T-1', '  Add  a\tparser\n')).toBe('T-1: Add a parser')
    expect(taskCommitMessage('T-1', '')).toBe('T-1: DevLoop task')
    const long = taskCommitMessage('g2-TASK-001', 'x'.repeat(200))
    expect(long).toHaveLength(72)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('mergeTaskWorktree', () => {
  it('merges the task branch, then removes the worktree and keeps the branch until cleanup', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'from-worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    await mergeTaskWorktree(root, 'd1', await readContractBaseSha(dest), await taskWorktreeHeadSha(dest))
    await expect(readFile(join(root, 'src.txt'), 'utf8')).resolves.toBe('from-worker\n')
    await expect(lstat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
    await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'devloop/d1'])
    await deleteMergedTaskBranch(root, 'd1')
    await expect(execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'devloop/d1'])).rejects.toThrow()
  }, 30_000)

  it('removes the worktree a forge merge left behind, then the branch; keeps one holding changes', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'from-worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    // What following a forge merge does: the checkout moves on, the task worktree stays.
    await execFileAsync('git', ['-C', root, 'merge', '-q', '--ff-only', 'devloop/d1'])
    await deleteMergedTaskBranch(root, 'd1')
    await expect(lstat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'devloop/d1'])).rejects.toThrow()

    const kept = await prepareDelegateWorktree(root, contractFor('d2'))
    await writeFile(join(kept, 'notes.txt'), 'not committed\n', 'utf8')
    await expect(deleteMergedTaskBranch(root, 'd2')).rejects.toThrow()
    await expect(readFile(join(kept, 'notes.txt'), 'utf8')).resolves.toBe('not committed\n')
  }, 30_000)

  it('host merge does not run hooks from the shared git directory', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'from-worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    const { stdout: commonDir } = await execFileAsync('git', [
      '-C', dest, 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ], { encoding: 'utf8' })
    const hooks = join(commonDir.trim(), 'hooks')
    const marker = join(root, 'post-merge-ran')
    await mkdir(hooks, { recursive: true })
    const hook = join(hooks, 'post-merge')
    await writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`, 'utf8')
    await chmod(hook, 0o755)
    await mergeTaskWorktree(root, 'd1', await readContractBaseSha(dest), await taskWorktreeHeadSha(dest))
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('refuses merge when the workspace has tracked changes', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'from-worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    await writeFile(join(root, 'README.md'), '# dirty main\n', 'utf8')
    await expect(mergeTaskWorktree(root, 'd1', await readContractBaseSha(dest))).rejects.toThrow(/tracked changes/)
    await expect(readFile(join(root, 'src.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await pathExists(dest)).toBe(true)
  })

  it('refuses merge when the worktree is missing', async () => {
    const root = await gitWorkspace()
    await expect(mergeTaskWorktree(root, 'd1', null)).rejects.toThrow(/registered task worktree/)
  })

  it('refuses an empty task branch that never moved past delegate', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await expect(mergeTaskWorktree(root, 'd1', await readContractBaseSha(dest))).rejects.toThrow(/empty_task/)
    expect(await pathExists(dest)).toBe(true)
    await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'devloop/d1'])
  })

  it('aborts a conflicted merge and leaves HEAD clean', async () => {
    const root = await gitWorkspace()
    await writeFile(join(root, 'src.txt'), 'main\n', 'utf8')
    await execFileAsync('git', ['-C', root, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'main-file'])
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker-file'])
    await writeFile(join(root, 'src.txt'), 'other\n', 'utf8')
    await execFileAsync('git', ['-C', root, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'main-other'])
    await expect(mergeTaskWorktree(
      root, 'd1', await readContractBaseSha(dest), await taskWorktreeHeadSha(dest),
    )).rejects.toThrow()
    const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' })
    expect(stdout).toBe('')
    await expect(execFileAsync('git', ['-C', root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'])).rejects.toThrow()
    await expect(readFile(join(root, 'src.txt'), 'utf8')).resolves.toBe('other\n')
    expect(await pathExists(dest)).toBe(true)
  }, 30_000)

  it('does not abort a merge that was already in progress', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'from-worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    await execFileAsync('git', ['-C', root, 'switch', '-c', 'human'])
    await writeFile(join(root, 'README.md'), '# human\n', 'utf8')
    await execFileAsync('git', ['-C', root, 'add', 'README.md'])
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'human'])
    await execFileAsync('git', ['-C', root, 'switch', 'main'])
    await writeFile(join(root, 'README.md'), '# other\n', 'utf8')
    await execFileAsync('git', ['-C', root, 'add', 'README.md'])
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'other'])
    await expect(execFileAsync('git', ['-C', root, 'merge', '--no-edit', 'human'])).rejects.toThrow()
    await writeFile(join(root, 'README.md'), '# resolved-but-uncommitted\n', 'utf8')
    await expect(mergeTaskWorktree(root, 'd1', await readContractBaseSha(dest))).rejects.toThrow(/already in progress/)
    await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toBe('# resolved-but-uncommitted\n')
    await execFileAsync('git', ['-C', root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'])
    expect(await pathExists(dest)).toBe(true)
  })

  it('refuses a dirty task worktree before merging', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'from-worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    await writeFile(join(dest, 'dirty.txt'), 'uncommitted\n', 'utf8')
    await expect(mergeTaskWorktree(root, 'd1', await readContractBaseSha(dest))).rejects.toThrow(/dirty/)
    await expect(readFile(join(root, 'src.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await pathExists(dest)).toBe(true)
  })

  it('refuses to merge onto a detached HEAD', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await writeFile(join(dest, 'src.txt'), 'from-worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    await execFileAsync('git', ['-C', root, 'checkout', '--detach'])
    await expect(mergeTaskWorktree(root, 'd1', await readContractBaseSha(dest))).rejects.toThrow(/^merge_detached_head: .*detached HEAD/)
    expect(await pathExists(dest)).toBe(true)
  })

  it('refuses to merge onto a branch the caller names as a trunk, and leaves it untouched', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('t1'))
    await writeFile(join(dest, 'src.txt'), 'from-worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    const head = (await execFileAsync('git', ['-C', root, 'branch', '--show-current'])).stdout.trim()
    const before = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
    const base = await readContractBaseSha(dest)
    const reviewed = await taskWorktreeHeadSha(dest)
    await expect(mergeTaskWorktree(root, 't1', base, reviewed, { trunks: new Set([head]) }))
      .rejects.toThrow(/^merge_onto_trunk: /)
    expect((await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(before)
    expect(await pathExists(dest)).toBe(true)
    // Without a trunk set the primitive behaves as it always has.
    await mergeTaskWorktree(root, 't1', base, reviewed, { trunks: new Set(['some-other-branch']) })
    expect(await pathExists(dest)).toBe(false)
  })

  it('refuses merge when the worktree is not on the task branch', async () => {
    const root = await gitWorkspace()
    const dest = worktreePath(root, 'd1')
    await execFileAsync('git', ['-C', root, 'worktree', 'add', '-b', 'sneaky', dest])
    await expect(mergeTaskWorktree(root, 'd1', null)).rejects.toThrow(/worktree branch must be/)
  })

  it('refuses to merge a task branch into itself', async () => {
    const root = await gitWorkspace()
    await execFileAsync('git', ['-C', root, 'switch', '-c', 'devloop/d1'])
    await expect(mergeTaskWorktree(root, 'd1', null)).rejects.toThrow(/into itself/)
  })

  it('merges a task branch even after the worktree is gone', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    const baseSha = await readContractBaseSha(dest)
    await writeFile(join(dest, 'src.txt'), 'from-worker\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    const reviewedSha = await taskWorktreeHeadSha(dest)
    await execFileAsync('git', ['-C', root, 'worktree', 'remove', dest])
    await mergeTaskWorktree(root, 'd1', baseSha, reviewedSha)
    await expect(readFile(join(root, 'src.txt'), 'utf8')).resolves.toBe('from-worker\n')
  })

  it('refuses an empty branch after the worktree is gone', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    const baseSha = await readContractBaseSha(dest)
    await execFileAsync('git', ['-C', root, 'worktree', 'remove', dest])
    await expect(mergeTaskWorktree(root, 'd1', baseSha)).rejects.toThrow(/empty_task/)
    await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'devloop/d1'])
  })

  it('refuses a task branch that moved after review', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    const baseSha = await readContractBaseSha(dest)
    await writeFile(join(dest, 'src.txt'), 'reviewed\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'reviewed'])
    const reviewedSha = await taskWorktreeHeadSha(dest)
    await writeFile(join(dest, 'later.txt'), 'unreviewed\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'later.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'moved'])
    await expect(mergeTaskWorktree(root, 'd1', baseSha, reviewedSha)).rejects.toThrow('stale_review_sha')
    await expect(readFile(join(root, 'src.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an empty branch when CONTRACT.json is missing', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    const baseSha = await readContractBaseSha(dest)
    await rm(join(dest, '.devloop', 'CONTRACT.json'))
    await expect(mergeTaskWorktree(root, 'd1', baseSha)).rejects.toThrow(/empty_task/)
    await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'devloop/d1'])
  })

  it('refuses merge when STATE did not record a baseSha', async () => {
    const root = await gitWorkspace()
    const dest = await prepareDelegateWorktree(root, contractFor('d1'))
    await expect(mergeTaskWorktree(root, 'd1', null)).rejects.toThrow(/unknown_base/)
    expect(await pathExists(dest)).toBe(true)
    await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'devloop/d1'])
  })
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

describe('host-enforced task write scope', () => {
  it('accepts an allowed change and exposes the host commit SHA', async () => {
    const root = await gitWorkspace()
    const contract = contractFor('scope-ok')
    const dest = await prepareDelegateWorktree(root, contract)
    const baseSha = await readContractBaseSha(dest)
    await mkdir(join(dest, 'src'))
    await writeFile(join(dest, 'src', 'persist.ts'), 'export const ok = true\n', 'utf8')
    await expect(assertTaskChangesAllowed(dest, { ...contract, baseSha: baseSha! }))
      .resolves.toEqual(['src/persist.ts'])
    await commitDirtyTaskWorktree(dest, 'scope-ok')
    await expect(taskWorktreeHeadSha(dest)).resolves.not.toBe(baseSha)
  })

  it('rejects paths outside allowedPaths and protected paths', async () => {
    const root = await gitWorkspace()
    const outside = contractFor('scope-outside')
    const outsideDest = await prepareDelegateWorktree(root, outside)
    const outsideBase = await readContractBaseSha(outsideDest)
    await writeFile(join(outsideDest, 'other.ts'), 'no\n', 'utf8')
    await expect(assertTaskChangesAllowed(outsideDest, { ...outside, baseSha: outsideBase! }))
      .rejects.toThrow('outside allowedPaths')

    const forbidden = contractFor('scope-forbidden')
    const forbiddenDest = await prepareDelegateWorktree(root, forbidden)
    const forbiddenBase = await readContractBaseSha(forbiddenDest)
    await writeFile(join(forbiddenDest, 'package.json'), '{}\n', 'utf8')
    await expect(assertTaskChangesAllowed(forbiddenDest, { ...forbidden, baseSha: forbiddenBase! }))
      .rejects.toThrow('forbidden path')
  })

  it('rejects symlink changes even when their path matches', async () => {
    const root = await gitWorkspace()
    const contract = contractFor('scope-link')
    const dest = await prepareDelegateWorktree(root, contract)
    const baseSha = await readContractBaseSha(dest)
    await mkdir(join(dest, 'src'))
    await symlink('/tmp/outside', join(dest, 'src', 'persist.ts'))
    await expect(assertTaskChangesAllowed(dest, { ...contract, baseSha: baseSha! }))
      .rejects.toThrow('symlink change')
  })
})

describe('fastForwardWorkBranch', () => {
  const g = (root: string, ...args: string[]) => execFileAsync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]).then(r => r.stdout.trim())
  const TRUNKS = new Set(['main', 'master'])

  /** A checkout on `work`, a bare forge, and a merge commit on the forge's `work` the checkout does not have. */
  async function forgeMerged(): Promise<{ root: string, forge: string, merge: string }> {
    const root = await gitWorkspace()
    await g(root, 'switch', '-q', '-c', 'work')
    const forge = await mkdtempInRepo('devloop-forge-')
    scratch.push(forge)
    await execFileAsync('git', ['clone', '-q', '--bare', root, forge])
    const side = await mkdtempInRepo('devloop-side-')
    scratch.push(side)
    await execFileAsync('git', ['clone', '-q', '-b', 'work', forge, side])
    await g(side, 'switch', '-q', '-c', 'devloop/T1')
    await writeFile(join(side, 'task.txt'), 'done\n', 'utf8')
    await g(side, 'add', '.')
    await g(side, 'commit', '-q', '-m', 'task')
    await g(side, 'switch', '-q', 'work')
    await g(side, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #7', 'devloop/T1')
    await g(side, 'push', '-q', 'origin', 'work')
    return { root, forge, merge: await g(side, 'rev-parse', 'HEAD') }
  }

  it('fetches the merge commit by id and fast-forwards the work branch to it', async () => {
    const { root, forge, merge } = await forgeMerged()
    await fastForwardWorkBranch(root, 'work', merge, forge, { trunks: TRUNKS })
    expect(await g(root, 'rev-parse', 'HEAD')).toBe(merge)
    expect(await g(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/work')
    // Again is nothing: the checkout is already there.
    await fastForwardWorkBranch(root, 'work', merge, forge, { trunks: TRUNKS })
    expect(await g(root, 'rev-parse', 'HEAD')).toBe(merge)
  })

  it('keeps every local-merge guard: detached, trunk, another branch, tracked changes', async () => {
    const { root, forge, merge } = await forgeMerged()
    await g(root, 'switch', '-q', '--detach')
    await expect(fastForwardWorkBranch(root, 'work', merge, forge, { trunks: TRUNKS })).rejects.toThrow(/^merge_detached_head/)
    await g(root, 'switch', '-q', 'main')
    await expect(fastForwardWorkBranch(root, 'work', merge, forge, { trunks: TRUNKS })).rejects.toThrow(/^merge_onto_trunk/)
    await g(root, 'switch', '-q', '-c', 'elsewhere')
    await expect(fastForwardWorkBranch(root, 'work', merge, forge, { trunks: TRUNKS })).rejects.toThrow(/^merge_wedged: the checkout is on elsewhere/)
    await g(root, 'switch', '-q', 'work')
    await writeFile(join(root, 'README.md'), 'changed\n', 'utf8')
    await expect(fastForwardWorkBranch(root, 'work', merge, forge, { trunks: TRUNKS })).rejects.toThrow(/^merge_wedged: the workspace has tracked changes/)
  })

  it('names a bare git or filesystem failure as the checkout\'s, so it is never taken for a forge refusal', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'devloop-not-a-repo-'))
    scratch.push(plain)
    const merge = 'a'.repeat(40)
    // Not a repository at all: git itself fails, with no prefix of its own.
    await expect(fastForwardWorkBranch(plain, 'work', merge, plain, { trunks: TRUNKS })).rejects.toThrow(/^merge_wedged: Command failed: git/)
    // Gone altogether: realpath fails before git runs.
    await expect(fastForwardWorkBranch(join(plain, 'gone'), 'work', merge, plain, { trunks: TRUNKS })).rejects.toThrow(/^merge_wedged: ENOENT/)
  })

  it('refuses a commit it cannot fetch, and one the work branch is not behind', async () => {
    const { root, forge } = await forgeMerged()
    await expect(fastForwardWorkBranch(root, 'work', 'f'.repeat(40), forge)).rejects.toThrow(/^merge_wedged: could not fetch/)
    // A local commit the merge does not contain: not a fast-forward.
    await writeFile(join(root, 'local.txt'), 'x\n', 'utf8')
    await g(root, 'add', 'local.txt')
    await g(root, 'commit', '-q', '-m', 'local')
    const other = await forgeMerged()
    await expect(fastForwardWorkBranch(root, 'work', other.merge, other.forge)).rejects.toThrow(/^merge_wedged: work at .* is not behind/)
    expect(await g(root, 'rev-parse', 'HEAD')).not.toBe(other.merge)
  })
})

describe('a task worktree whose gitdir a worker could write', () => {
  // A worker given write to <root>/.git/worktrees/<id> can point `commondir` at a
  // repository of its own, whose config names a program git runs: the host's next
  // git call in that worktree would run it. The host's git must not follow it.
  it('never runs a program named by a common dir the worktree was pointed at', async () => {
    const root = await gitWorkspace()
    const contract = contractFor('pwn')
    const tree = await prepareDelegateWorktree(root, contract)
    const fake = await mkdtempInRepo('devloop-fake-common-')
    scratch.push(fake)
    await execFileAsync('cp', ['-R', join(root, '.git') + '/.', fake])
    const marker = join(fake, 'PWNED')
    const hook = join(fake, 'monitor.sh')
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, 'utf8')
    await chmod(hook, 0o755)
    await execFileAsync('git', ['config', '--file', join(fake, 'config'), 'core.fsmonitor', hook])
    await writeFile(join(root, '.git', 'worktrees', 'pwn', 'commondir'), `${fake}\n`, 'utf8')
    await writeFile(join(tree, 'src.txt'), 'work\n', 'utf8')
    await expect(commitDirtyTaskWorktree(tree, 'pwn')).rejects.toThrow(/pointed at another repository|refusing parent commit/)
    await expect(lstat(marker)).rejects.toThrow()
    // The pre-PR checker runs git in the worktree too: it is refused as unavailable, never run there.
    const { runPreprCheck } = await import('../src/prepr.ts')
    const check = await runPreprCheck(['sh', '-c', 'git status >/dev/null; echo {}'], 'devloop', tree, 'a'.repeat(40), 10_000)
    expect(check).toMatchObject({ status: 'unavailable' })
    expect(check.detail).toMatch(/pointed at another repository/)
    await expect(lstat(marker)).rejects.toThrow()
  })

  it('still commits in an untouched worktree, with git pinned to the host\'s own directories', async () => {
    const root = await gitWorkspace()
    const tree = await prepareDelegateWorktree(root, contractFor('ok1'))
    await writeFile(join(tree, 'src.txt'), 'work\n', 'utf8')
    await commitDirtyTaskWorktree(tree, 'ok1')
    expect((await execFileAsync('git', ['-C', tree, 'log', '-1', '--format=%s'])).stdout.trim()).toBe('ok1: DevLoop task')
  })
})

describe('the repository status scan over a worker\'s worktree', () => {
  // No gitdir access needed: the worker rewrites the `.git` pointer inside its own worktree to a
  // linked gitdir of its own, whose commondir names a repository with a program in its config.
  it('runs git status there without running anything the worktree points at, and counts it dirty', async () => {
    const root = await gitWorkspace()
    const tree = await prepareDelegateWorktree(root, contractFor('scan'))
    const fake = await mkdtempInRepo('devloop-fake-scan-')
    scratch.push(fake)
    const common = join(fake, 'common')
    await execFileAsync('cp', ['-R', join(root, '.git') + '/.', common])
    const marker = join(fake, 'PWNED')
    const hook = join(fake, 'monitor.sh')
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, 'utf8')
    await chmod(hook, 0o755)
    await execFileAsync('git', ['config', '--file', join(common, 'config'), 'core.fsmonitor', hook])
    const linked = join(common, 'worktrees', 'scan')
    await writeFile(join(linked, 'commondir'), `${common}\n`, 'utf8')
    await writeFile(join(tree, '.git'), `gitdir: ${linked}\n`, 'utf8')
    const { scanRepo } = await import('../src/status.ts')
    const status = await scanRepo(root)
    await expect(lstat(marker)).rejects.toThrow()
    expect(status.worktrees.find(w => w.path.endsWith('/.devloop/worktrees/scan'))).toBeDefined()
  })
})
