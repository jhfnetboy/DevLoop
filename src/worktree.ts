import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { DEVLOOP_DIR, devloopDir } from './persist.js'
import type { TaskContract } from './types.js'

const execFileAsync = promisify(execFile)

export const WORKTREES_DIR = 'worktrees'
export const CONTRACT_FILE = 'CONTRACT.json'
export const WORKTREE_BRANCH_PREFIX = 'devloop/'
/** Reserved worktree id for T3 `plan`. Leading `_` is outside TASK_TOKEN. */
export const PLAN_WORKTREE_ID = '_loop-plan'

const TASK_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function worktreeTaskToken(taskId: string): string | null {
  if (!TASK_TOKEN.test(taskId)) return null
  if (taskId.includes('..') || taskId.endsWith('.') || taskId.endsWith('.lock')) return null
  if (taskId === PLAN_WORKTREE_ID) return null
  return taskId
}

function worktreeDir(root: string, token: string): string {
  return join(devloopDir(root), WORKTREES_DIR, token)
}

export function worktreePath(root: string, taskId: string): string {
  const token = worktreeTaskToken(taskId)
  if (!token) throw new Error(`unsafe task id for worktree: ${taskId}`)
  return worktreeDir(root, token)
}

/** Path of the reserved T3 plan worktree. Not a valid user task id. */
export function planWorktreePath(root: string): string {
  return worktreeDir(root, PLAN_WORKTREE_ID)
}

export function contractPath(root: string, taskId: string): string {
  return join(worktreePath(root, taskId), DEVLOOP_DIR, CONTRACT_FILE)
}

/**
 * Create (or reuse) a git worktree for this task and freeze the contract
 * at `<worktree>/.devloop/CONTRACT.json`. Returns the worktree root.
 */
export async function prepareDelegateWorktree(root: string, contract: TaskContract): Promise<string> {
  const token = worktreeTaskToken(contract.taskId)
  if (!token) throw new Error(`unsafe task id for worktree: ${contract.taskId}`)
  return checkoutWorktree(root, token, contract)
}

async function ensureWorktreePool(root: string): Promise<{ resolvedRoot: string, pool: string }> {
  const resolvedRoot = await realpath(root)
  const toplevel = (await git(resolvedRoot, ['rev-parse', '--show-toplevel'])).trim()
  if (await realpath(toplevel) !== resolvedRoot) {
    throw new Error('workspace root must be the git toplevel')
  }

  const loopDir = join(resolvedRoot, DEVLOOP_DIR)
  const loopMeta = await lstat(loopDir)
  if (loopMeta.isSymbolicLink() || !loopMeta.isDirectory()) {
    throw new Error('devloop directory must be a real directory inside the workspace')
  }
  if (await realpath(loopDir) !== loopDir) {
    throw new Error('devloop directory must be a real directory inside the workspace')
  }

  const pool = await ensureRealDir(join(loopDir, WORKTREES_DIR), loopDir)
  await ignoreWorktrees(pool)
  return { resolvedRoot, pool }
}

async function checkoutWorktree(root: string, token: string, contract: TaskContract): Promise<string> {
  const { resolvedRoot, pool } = await ensureWorktreePool(root)
  const dest = join(pool, token)
  const listed = await listedWorktreePaths(resolvedRoot)
  const branch = `${WORKTREE_BRANCH_PREFIX}${token}`
  if (await pathExists(dest)) {
    if (!await isRegisteredWorktree(listed, dest)) {
      throw new Error('worktree destination exists but is not a git worktree')
    }
    await assertInside(pool, dest)
    await ensureWorktreeBranch(dest, branch)
    await writeContractFile(dest, await stampBaseSha(dest, contract))
    return dest
  }

  await git(resolvedRoot, ['worktree', 'add', '-B', branch, dest])
  await assertInside(pool, dest)
  await writeContractFile(dest, await stampBaseSha(dest, contract))
  return dest
}

/**
 * Isolated detached worktree so T3 plan does not run in the operator workspace
 * and does not create or reset `devloop/_loop-plan`. Always reset to workspace
 * HEAD. Copies GOAL.md because `.devloop/` is typically untracked.
 * Caller should `removePlanWorktree` after the one-shot run.
 */
export async function preparePlanWorktree(root: string): Promise<string> {
  try {
    const { resolvedRoot, pool } = await ensureWorktreePool(root)
    const dest = join(pool, PLAN_WORKTREE_ID)
    const listed = await listedWorktreePaths(resolvedRoot)
    if (await pathExists(dest)) {
      if (!await isRegisteredWorktree(listed, dest)) {
        throw new Error('worktree destination exists but is not a git worktree')
      }
      await assertInside(pool, dest)
    } else {
      await git(resolvedRoot, ['worktree', 'add', '--detach', dest])
      await assertInside(pool, dest)
    }
    await git(dest, ['checkout', '--detach', '-f'])
    const head = (await git(resolvedRoot, ['rev-parse', 'HEAD'])).trim()
    await git(dest, ['reset', '--hard', head])
    const srcGoal = join(resolvedRoot, DEVLOOP_DIR, 'GOAL.md')
    const destLoop = await ensureRealDir(join(dest, DEVLOOP_DIR), dest)
    const destGoal = join(destLoop, 'GOAL.md')
    const meta = await lstat(srcGoal)
    if (meta.isSymbolicLink()) throw new Error('refusing symlink GOAL.md')
    await copyFile(srcGoal, destGoal)
    return dest
  } catch (error) {
    try {
      await removePlanWorktree(root)
    } catch {
      // surface the original failure
    }
    throw error
  }
}

/** Force-remove the reserved plan worktree. Does not delete any branch. Missing is success. */
export async function removePlanWorktree(root: string): Promise<void> {
  const resolvedRoot = await realpath(root)
  const dest = planWorktreePath(resolvedRoot)
  try {
    await git(resolvedRoot, ['worktree', 'remove', '--force', dest])
  } catch {
    if (await pathExists(dest)) {
      throw new Error(`failed to remove plan worktree: ${dest}`)
    }
    await git(resolvedRoot, ['worktree', 'prune'])
  }
}

/**
 * Merge `devloop/<taskId>` into the workspace HEAD, then remove the worktree
 * and delete the task branch. Caller must already have enforced Review PASS.
 * Does not push. `recordedBaseSha` is the delegate SHA from STATE: missing is
 * `unknown_base`, unchanged branch is `empty_task`. Throws without mutating STATE.
 * Idempotent if a previous attempt already merged and removed the worktree.
 */
export async function mergeTaskWorktree(
  root: string,
  taskId: string,
  recordedBaseSha: string | null,
): Promise<void> {
  const token = worktreeTaskToken(taskId)
  if (!token) throw new Error(`unsafe task id for worktree: ${taskId}`)

  const resolvedRoot = await realpath(root)
  const toplevel = (await git(resolvedRoot, ['rev-parse', '--show-toplevel'])).trim()
  if (await realpath(toplevel) !== resolvedRoot) {
    throw new Error('workspace root must be the git toplevel')
  }

  if (await mergeHeadExists(resolvedRoot)) {
    throw new Error('refusing to merge while a merge is already in progress')
  }

  const headRef = await symbolicHead(resolvedRoot)
  if (!headRef) {
    throw new Error('refusing to merge onto a detached HEAD')
  }

  const branch = `${WORKTREE_BRANCH_PREFIX}${token}`
  if (headRef === `refs/heads/${branch}`) {
    throw new Error('refusing to merge a task branch into itself')
  }

  const dest = worktreePath(resolvedRoot, token)
  const listed = await listedWorktreePaths(resolvedRoot)
  const present = await pathExists(dest) && await isRegisteredWorktree(listed, dest)
  if (present) {
    if (await symbolicHead(dest) !== `refs/heads/${branch}`) {
      throw new Error(`worktree branch must be ${branch}`)
    }
    const dirty = (await git(dest, ['status', '--porcelain', '--untracked-files=all'])).trim()
    if (dirty.length > 0) {
      throw new Error('task worktree is dirty; commit or clean it before merge')
    }
  } else if (!await gitOk(resolvedRoot, ['rev-parse', '--verify', `refs/heads/${branch}`])) {
    throw new Error('merge requires a registered task worktree')
  }

  const trackedDirty = (await git(resolvedRoot, ['status', '--porcelain', '--untracked-files=no'])).trim()
  if (trackedDirty.length > 0) {
    throw new Error('workspace has tracked changes; commit or stash them before merge')
  }

  const expected = normalizeSha(recordedBaseSha)
  if (expected === null) {
    throw new Error('unknown_base')
  }
  const branchSha = (await git(resolvedRoot, ['rev-parse', `refs/heads/${branch}`])).trim().toLowerCase()
  if (branchSha === expected) {
    throw new Error('empty_task')
  }

  try {
    await git(resolvedRoot, ['merge', '--no-edit', '-m', `devloop: merge ${token}`, branch])
  } catch (error) {
    if (await mergeHeadExists(resolvedRoot)) {
      try {
        await git(resolvedRoot, ['merge', '--abort'])
      } catch (abortError) {
        throw new Error('merge_wedged: git merge --abort failed', { cause: abortError })
      }
    }
    const stderr = error instanceof Error && 'stderr' in error
      ? String((error as { stderr?: string }).stderr).trim()
      : ''
    throw new Error(stderr.length > 0 ? `git merge failed: ${stderr}` : 'git merge failed', { cause: error })
  }

  if (present) {
    try {
      await git(resolvedRoot, ['worktree', 'remove', dest])
    } catch (error) {
      if (await pathExists(dest)) throw error
    }
  }
}

/**
 * Delete `devloop/<taskId>` after STATE has recorded the merge. Missing ref
 * is success; any other `branch -d` failure is thrown.
 */
export async function deleteMergedTaskBranch(root: string, taskId: string): Promise<void> {
  const token = worktreeTaskToken(taskId)
  if (!token) throw new Error(`unsafe task id for worktree: ${taskId}`)
  const resolvedRoot = await realpath(root)
  const branch = `${WORKTREE_BRANCH_PREFIX}${token}`
  try {
    await git(resolvedRoot, ['worktree', 'prune'])
  } catch {
    // Best-effort; deleting the ref is the actual cleanup.
  }
  try {
    await git(resolvedRoot, ['branch', '-d', branch])
  } catch (error) {
    if (await gitOk(resolvedRoot, ['rev-parse', '--verify', `refs/heads/${branch}`])) {
      throw error
    }
  }
}

async function stampBaseSha(worktreeRoot: string, contract: TaskContract): Promise<TaskContract> {
  const head = (await git(worktreeRoot, ['rev-parse', 'HEAD'])).trim()
  const previous = await readContractBaseSha(worktreeRoot)
  return { ...contract, baseSha: previous ?? head.toLowerCase() }
}

export async function readContractBaseSha(worktreeRoot: string): Promise<string | null> {
  try {
    const raw = await readFile(join(worktreeRoot, DEVLOOP_DIR, CONTRACT_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const sha = (parsed as { baseSha?: unknown }).baseSha
    return normalizeSha(typeof sha === 'string' ? sha : null)
  } catch {
    return null
  }
}

function normalizeSha(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null
}

async function writeContractFile(worktreeRoot: string, contract: TaskContract): Promise<void> {
  const dir = await ensureRealDir(join(worktreeRoot, DEVLOOP_DIR), worktreeRoot)
  const file = join(dir, CONTRACT_FILE)
  try {
    const meta = await lstat(file)
    if (meta.isSymbolicLink()) throw new Error('refusing symlink contract file')
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  await writeFile(file, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  await assertInside(dir, file)
  await ignoreDir(dir)
}

async function ensureRealDir(path: string, parent: string): Promise<string> {
  await mkdir(path, { recursive: true })
  const meta = await lstat(path)
  if (meta.isSymbolicLink() || !meta.isDirectory()) {
    throw new Error(`refusing symlink or non-directory: ${path}`)
  }
  await assertInside(parent, path)
  return path
}

async function assertInside(parent: string, child: string): Promise<void> {
  const resolvedParent = await realpath(parent)
  const resolvedChild = await realpath(child)
  if (resolvedChild !== resolvedParent && !resolvedChild.startsWith(resolvedParent + sep)) {
    throw new Error(`path escapes worktree pool: ${child}`)
  }
}

async function isRegisteredWorktree(listed: Set<string>, dest: string): Promise<boolean> {
  const resolved = await realpath(dest)
  for (const entry of listed) {
    try {
      if (await realpath(entry) === resolved) return true
    } catch {
      continue
    }
  }
  return false
}

async function listedWorktreePaths(root: string): Promise<Set<string>> {
  const raw = await git(root, ['worktree', 'list', '--porcelain'])
  const paths = new Set<string>()
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.add(line.slice('worktree '.length))
    }
  }
  return paths
}

async function ignoreWorktrees(pool: string): Promise<void> {
  await ignoreDir(pool)
}

async function ignoreDir(dir: string): Promise<void> {
  const file = join(dir, '.gitignore')
  try {
    const meta = await lstat(file)
    if (meta.isSymbolicLink()) throw new Error('refusing symlink gitignore')
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  await writeFile(file, '*\n', 'utf8')
  await assertInside(dir, file)
}

async function ensureWorktreeBranch(dest: string, branch: string): Promise<void> {
  const expected = `refs/heads/${branch}`
  if (await symbolicHead(dest) === expected) return
  try {
    await git(dest, ['switch', branch])
  } catch (error) {
    throw new Error(`worktree branch must be ${branch}`, { cause: error })
  }
  if (await symbolicHead(dest) !== expected) {
    throw new Error(`worktree branch must be ${branch}`)
  }
}

async function mergeHeadExists(root: string): Promise<boolean> {
  return gitOk(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
}

async function gitOk(root: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(root, args)
    return true
  } catch {
    return false
  }
}

async function symbolicHead(worktreeRoot: string): Promise<string | null> {
  try {
    const ref = (await git(worktreeRoot, ['symbolic-ref', '--quiet', 'HEAD'])).trim()
    return ref.length > 0 ? ref : null
  } catch {
    return null
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
  })
  return stdout
}
