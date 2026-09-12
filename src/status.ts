import { baseBranch, git, PROTECT_FLOOR, readPilotConfig, trunkBranches } from './readiness.js'

/**
 * What a repository looks like right now, for the page's 仓库状态 panel: the
 * read-only half of pilot's `status`. Every git call goes through readiness's
 * helper, so none of them takes the index lock from a loop mid-merge.
 */
export interface BranchStatus {
  readonly name: string
  /** Fully merged into HEAD: exactly the branches `git branch -d` would accept. */
  readonly merged: boolean
  /** Why this branch must never be deleted, or null. */
  readonly protectedBy: 'current' | 'trunk' | 'pattern' | 'worktree' | 'active_task' | null
}

export interface WorktreeStatus {
  readonly path: string
  /** Null for a detached worktree. */
  readonly branch: string | null
  readonly dirty: boolean
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
}

export interface ScanOptions {
  /** Branches of tasks the loop has not finished; never offered for deletion. */
  readonly activeBranches?: ReadonlySet<string>
}

export async function scanRepo(root: string, options: ScanOptions = {}): Promise<RepoStatus> {
  const pilot = await readPilotConfig(root)
  const base = await baseBranch(root, pilot)
  const trunks = await trunkBranches(root)
  const patterns = pilot?.protectPatterns ?? PROTECT_FLOOR
  const branch = await optional(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const worktrees = await listWorktrees(root)
  // Every comparison below is case-folded: on APFS or NTFS `git switch Feature`
  // over a loose `feature` ref leaves HEAD at refs/heads/Feature while
  // for-each-ref lists `feature`, and an exact match would then offer the
  // current branch for deletion — the same ref file.
  const fold = (name: string): string => name.toLowerCase()
  const current = branch === null ? null : fold(branch)
  const checkedOut = new Set(worktrees.map(w => w.branch).filter((b): b is string => b !== null).map(fold))
  const active = new Set([...(options.activeBranches ?? [])].map(fold))
  const merged = new Set(lines(await optional(root, ['branch', '--merged', 'HEAD', '--format=%(refname:short)']) ?? ''))
  const names = lines(await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))

  const branches = names.map((name): BranchStatus => {
    let protectedBy: BranchStatus['protectedBy'] = null
    if (fold(name) === current) protectedBy = 'current'
    else if (trunks.has(fold(name))) protectedBy = 'trunk'
    else if (patterns.some(p => fold(name).startsWith(fold(p)))) protectedBy = 'pattern'
    else if (checkedOut.has(fold(name))) protectedBy = 'worktree'
    else if (active.has(fold(name))) protectedBy = 'active_task'
    return { name, merged: merged.has(name), protectedBy }
  })

  const counts = await optional(root, ['rev-list', '--left-right', '--count', `refs/heads/${base}...HEAD`])
  const [behind, ahead] = counts === null ? [null, null] : counts.trim().split(/\s+/).map(Number)
  return {
    branch,
    base,
    trackedChanges: lines(await git(root, ['status', '--porcelain', '--untracked-files=no'])).length,
    ahead: ahead ?? null,
    behind: behind ?? null,
    branches,
    worktrees,
  }
}

async function listWorktrees(root: string): Promise<WorktreeStatus[]> {
  const out: WorktreeStatus[] = []
  let path: string | null = null
  let branch: string | null = null
  const flush = async (): Promise<void> => {
    if (path === null) return
    const status = await optional(path, ['status', '--porcelain'])
    // Unreadable counts as dirty: it is the answer that keeps a worktree's files.
    out.push({ path, branch, dirty: status === null || status.trim() !== '' })
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
