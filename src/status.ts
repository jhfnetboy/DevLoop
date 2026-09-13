import { realpath } from 'node:fs/promises'
import { baseBranch, git, isToplevel, protectedPrefixes, readPilotConfig, trunkBranches, type ProtectDrop } from './readiness.js'

/** The read-only half of pilot's `status`, for the 仓库状态 panel. Git runs through
 * readiness's helper, so no call takes the index lock from a loop mid-merge. */
export interface BranchStatus {
  readonly name: string
  /** Merged into HEAD. `git branch -d` also takes a branch merged into its upstream, so
   * this is a subset of what -d accepts; cleanup still runs -d and reports each refusal. */
  readonly merged: boolean
  /** Why this branch must never be deleted, or null. */
  readonly protectedBy: 'current' | 'trunk' | 'pattern' | 'worktree' | 'active_task' | null
}

export interface WorktreeStatus {
  readonly path: string
  readonly branch: string | null // null when detached
  readonly dirty: boolean
  /** The main checkout: the first `git worktree list` entry, whatever HEAD points at. */
  readonly primary: boolean
  /** The checkout this scan ran in — the project itself, even when it is a linked worktree. */
  readonly current: boolean
}

export interface RepoStatus {
  readonly branch: string | null
  readonly base: string
  readonly trackedChanges: number
  /** Commits on HEAD not on the base, and the other way; null when there is no base to compare. */
  readonly ahead: number | null
  readonly behind: number | null
  readonly branches: readonly BranchStatus[]
  readonly worktrees: readonly WorktreeStatus[]
  /** protect_patterns entries that protect nothing, so the page can say so. */
  readonly protectDropped: readonly ProtectDrop[]
}

export interface ScanOptions {
  /** Branches of tasks the loop has not finished; never offered for deletion. */
  readonly activeBranches?: ReadonlySet<string>
}

export async function scanRepo(root: string, options: ScanOptions = {}): Promise<RepoStatus> {
  // Otherwise git answers for an enclosing repository, and cleanup acts on its branches.
  if (!await isToplevel(root)) throw new Error('not a git toplevel')
  const base = await baseBranch(root, await readPilotConfig(root))
  const trunks = await trunkBranches(root)
  const { patterns, dropped } = await protectedPrefixes(root)
  const branch = (await optional(root, ['symbolic-ref', '--quiet', 'HEAD']))?.replace(/^refs\/heads\//, '') || null
  const worktrees = await listWorktrees(root)
  // Case-folded: on APFS `git switch Feature` over a loose `feature` ref makes
  // HEAD `Feature`; an exact match would offer the current branch for deletion.
  const fold = (name: string): string => name.toLowerCase()
  const current = branch === null ? null : fold(branch)
  const checkedOut = new Set(worktrees.map(w => w.branch).filter((b): b is string => b !== null).map(fold))
  const active = new Set([...(options.activeBranches ?? [])].map(fold))
  const merged = new Set(lines(await optional(root, ['branch', '--merged', 'HEAD', '--format=%(refname:lstrip=2)']) ?? ''))
  const names = lines(await git(root, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads']))

  const branches = names.map((name): BranchStatus => {
    let protectedBy: BranchStatus['protectedBy'] = null
    if (fold(name) === current) protectedBy = 'current'
    else if (trunks.has(fold(name))) protectedBy = 'trunk'
    else if (patterns.some(p => fold(name).startsWith(fold(p)))) protectedBy = 'pattern'
    else if (checkedOut.has(fold(name))) protectedBy = 'worktree'
    else if (active.has(fold(name))) protectedBy = 'active_task'
    return { name, merged: merged.has(name), protectedBy }
  })

  // Against the trunk as the remote has it when there is one: a local trunk nobody pulls lags behind it.
  const remoteBase = `refs/remotes/origin/${base}`
  const against = await optional(root, ['rev-parse', '--verify', '--quiet', remoteBase]) === null ? `refs/heads/${base}` : remoteBase
  const counts = await optional(root, ['rev-list', '--left-right', '--count', `${against}...HEAD`])
  const [behind, ahead] = counts === null ? [null, null] : counts.trim().split(/\s+/).map(Number)
  return {
    branch,
    base,
    trackedChanges: lines(await git(root, ['status', '--porcelain', '--untracked-files=no'])).length,
    ahead: ahead ?? null,
    behind: behind ?? null,
    branches,
    worktrees,
    protectDropped: dropped,
  }
}

async function listWorktrees(root: string): Promise<WorktreeStatus[]> {
  const here = await realpath(root)
  const out: WorktreeStatus[] = []
  let path: string | null = null
  let branch: string | null = null
  const flush = async (): Promise<void> => {
    if (path === null) return
    const status = await optional(path, ['status', '--porcelain'])
    // Unreadable counts as dirty: it is the answer that keeps a worktree's files.
    const current = await realpath(path).then(real => real === here, () => false)
    out.push({ path, branch, dirty: status === null || status.trim() !== '', primary: out.length === 0, current })
    path = null
    branch = null
  }
  for (const line of (await git(root, ['worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) {
      await flush()
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length)
    }
  }
  await flush()
  return out
}

async function optional(root: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await git(root, args)).trim()
  } catch {
    return null
  }
}

function lines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}
