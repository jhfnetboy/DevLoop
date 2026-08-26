import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { DEVLOOP_DIR, devloopDir } from './persist.js'
import type { TaskContract } from './types.js'

const execFileAsync = promisify(execFile)

export const WORKTREES_DIR = 'worktrees'
export const CONTRACT_FILE = 'CONTRACT.json'
export const WORKTREE_BRANCH_PREFIX = 'devloop/'

const TASK_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function worktreeTaskToken(taskId: string): string | null {
  if (!TASK_TOKEN.test(taskId)) return null
  if (taskId.includes('..') || taskId.endsWith('.') || taskId.endsWith('.lock')) return null
  return taskId
}

export function worktreePath(root: string, taskId: string): string {
  const token = worktreeTaskToken(taskId)
  if (!token) throw new Error(`unsafe task id for worktree: ${taskId}`)
  return join(devloopDir(root), WORKTREES_DIR, token)
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
  const dest = join(pool, token)
  await ignoreWorktrees(pool)

  const listed = await listedWorktreePaths(resolvedRoot)
  const branch = `${WORKTREE_BRANCH_PREFIX}${token}`
  if (await pathExists(dest)) {
    if (!await isRegisteredWorktree(listed, dest)) {
      throw new Error('worktree destination exists but is not a git worktree')
    }
    await assertInside(pool, dest)
    const current = (await git(dest, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (current !== branch) {
      throw new Error(`worktree branch must be ${branch}, found ${current}`)
    }
    await writeContractFile(dest, contract)
    return dest
  }

  await git(resolvedRoot, ['worktree', 'add', '-B', branch, dest])
  await assertInside(pool, dest)
  await writeContractFile(dest, contract)
  return dest
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
  const file = join(pool, '.gitignore')
  try {
    const meta = await lstat(file)
    if (meta.isSymbolicLink()) throw new Error('refusing symlink gitignore')
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  await writeFile(file, '*\n', 'utf8')
  await assertInside(pool, file)
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
  })
  return stdout
}
