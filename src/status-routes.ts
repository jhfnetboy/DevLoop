import { applyCleanup, planCleanup, type CleanupPlan, type CleanupResult } from './cleanup.js'
import { loadState, withStateLock, workspaceArmed } from './persist.js'
import { scanRepo, type RepoStatus } from './status.js'
import { WORKTREE_BRANCH_PREFIX, worktreeTaskToken } from './worktree.js'

/** The page's 仓库状态 panel: a scan and the cleanup it would do. */
export interface StatusView {
  readonly status: RepoStatus
  readonly plan: CleanupPlan
}

/** The branch of every task the loop has not finished; cleanup never offers these. */
async function activeBranches(root: string): Promise<Set<string>> {
  if (!await workspaceArmed(root)) return new Set()
  const state = await loadState(root, Date.now())
  const names = new Set<string>()
  for (const task of state.tasks) {
    if (task.status === 'done') continue
    const token = worktreeTaskToken(task.id)
    if (token !== null) names.add(`${WORKTREE_BRANCH_PREFIX}${token}`)
  }
  return names
}

export async function statusView(root: string): Promise<StatusView> {
  const status = await scanRepo(root, { activeBranches: await activeBranches(root) })
  return { status, plan: planCleanup(status) }
}

const MAX_BRANCHES = 500
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/

/** The confirmed names from a request body, or a reason the body is refused. */
export function confirmedBranches(body: Record<string, unknown>): readonly string[] | string {
  const list = body.branches
  if (!Array.isArray(list) || list.length === 0) return 'branches must be a non-empty list'
  if (list.length > MAX_BRANCHES) return `at most ${MAX_BRANCHES} branches`
  if (!list.every(name => typeof name === 'string' && BRANCH.test(name))) return 'every branch must be a plain branch name'
  return list as string[]
}

/**
 * Apply a confirmed cleanup. An armed project may have a loop creating and
 * merging branches, so its state lock is held throughout and the active set is
 * read inside it; `busy` means the loop holds the lock and nothing was touched.
 */
export async function runCleanup(root: string, confirmed: readonly string[]): Promise<CleanupResult | 'busy'> {
  const run = async (): Promise<CleanupResult> => applyCleanup(root, confirmed, { activeBranches: await activeBranches(root) })
  if (!await workspaceArmed(root)) return run()
  const locked = await withStateLock(root, run)
  return locked.ok ? locked.value : 'busy'
}
