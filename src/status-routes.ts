import { applyCleanup, planCleanup, type CleanupPlan, type CleanupResult } from './cleanup.js'
import { loadState, withStateLock, workspaceArmed } from './persist.js'
import { integrityHold } from './resume.js'
import { scanRepo, type RepoStatus } from './status.js'
import { WORKTREE_BRANCH_PREFIX, worktreeTaskToken } from './worktree.js'

/** The page's 仓库状态 panel: a scan and the cleanup it would do. */
export interface StatusView {
  readonly status: RepoStatus
  readonly plan: CleanupPlan
}

/** STATE could not be read, so which task branches are live is unknown. */
export class UnreadableStateError extends Error {}

/**
 * The branch of every task the loop has not finished; cleanup never offers
 * these. An unreadable STATE loads as a halted placeholder with no tasks, and an
 * empty set would then offer every task branch: refuse instead.
 */
async function activeBranches(root: string): Promise<Set<string>> {
  if (!await workspaceArmed(root)) return new Set()
  const state = await loadState(root, Date.now())
  if (integrityHold(state) !== null) throw new UnreadableStateError('state_unreadable')
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
/**
 * Only what could never be a branch, or could be read as an option. The real
 * allowlist is the plan rebuilt at apply time: a name is deleted only if that
 * plan offers it, and it reaches git after `--`. A stricter pattern here refused
 * names git allows (`fix#12`, `feat/ä`), and with every offered branch ticked by
 * default one of them turned the whole cleanup into a 400.
 */
const BRANCH = /^(?!-)[^\x00-\x1f\x7f]{1,255}$/u

/** The confirmed names from a request body, or a reason the body is refused. */
export function confirmedBranches(body: Record<string, unknown>): readonly string[] | string {
  const list = body.branches
  if (!Array.isArray(list) || list.length === 0) return 'branches must be a non-empty list'
  if (list.length > MAX_BRANCHES) return `at most ${MAX_BRANCHES} branches`
  if (!list.every(name => typeof name === 'string' && BRANCH.test(name))) return 'every branch must be a branch name: no leading -, no control characters'
  return list as string[]
}

/**
 * Apply a confirmed cleanup. The state lock is held only to read which task
 * branches are live, not through the scan and the deletes: a loop that finds
 * the lock busy when saving a model result drops that result, and a cleanup of
 * many branches held it for over a second. Nothing needs it longer — git
 * refuses to delete a branch a worktree has checked out (so a task started
 * after the read is safe) or one not merged. `busy` means the loop held the
 * lock at that moment and nothing was touched.
 */
export async function runCleanup(root: string, confirmed: readonly string[]): Promise<CleanupResult | 'busy'> {
  let active = new Set<string>()
  if (await workspaceArmed(root)) {
    const locked = await withStateLock(root, () => activeBranches(root))
    if (!locked.ok) return 'busy'
    active = locked.value
  }
  return applyCleanup(root, confirmed, { activeBranches: active })
}
