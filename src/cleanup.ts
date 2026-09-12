import { git } from './readiness.js'
import { scanRepo, type RepoStatus, type ScanOptions } from './status.js'

/**
 * The acting half of pilot's status, with the same edges as its
 * safe-cleanup.sh: the only thing ever executed is `git branch -d`, which git
 * itself refuses for an unmerged branch or one a worktree has checked out.
 * `-D` and `git worktree remove` are listed with a command for a person to run,
 * never run here. Remote branches are not touched at all: the scan reads only
 * refs/heads, so none is ever offered or listed.
 */
export interface CleanupPlan {
  /** Merged into HEAD and protected by nothing: what `apply` may delete. */
  readonly delete: readonly string[]
  readonly keep: readonly { readonly name: string, readonly reason: string }[]
  readonly manual: readonly { readonly target: string, readonly reason: string, readonly command: string }[]
}

const KEEP_REASON: Record<NonNullable<RepoStatus['branches'][number]['protectedBy']>, string> = {
  current: '当前分支',
  trunk: '主干',
  pattern: '受保护前缀（.pilot.yml protect_patterns 或 release/hotfix/deploy）',
  worktree: '被某个 worktree 检出',
  active_task: '循环里还没完成的任务',
}

export function planCleanup(status: RepoStatus): CleanupPlan {
  const del: string[] = []
  const keep: { name: string, reason: string }[] = []
  const manual: { target: string, reason: string, command: string }[] = []
  for (const b of status.branches) {
    if (b.protectedBy !== null) keep.push({ name: b.name, reason: KEEP_REASON[b.protectedBy] })
    else if (b.merged) del.push(b.name)
    else {
      keep.push({ name: b.name, reason: '还没合并进当前分支' })
      // A task branch the loop gave up on is the usual leftover; deleting
      // unmerged work is still a person's call.
      if (b.name.startsWith('devloop/')) {
        manual.push({ target: b.name, reason: '未合并的 DevLoop 任务分支', command: `git branch -D -- ${quote(b.name)}` })
      }
    }
  }
  for (const w of status.worktrees) {
    // The primary checkout, and DevLoop's own task and plan worktrees, which
    // the loop creates and removes itself.
    // Never the main checkout (known by position: on a detached HEAD it has no
    // branch to match) and never the project's own checkout, which is a linked
    // worktree when the project was registered from one — git would remove it.
    if (w.primary || w.current || /[/\\]\.devloop[/\\]worktrees[/\\]/.test(w.path)) continue
    manual.push(w.dirty
      ? { target: w.path, reason: 'worktree 有未提交的改动，先看一眼', command: `git -C ${quote(w.path)} status` }
      : { target: w.path, reason: '干净的 worktree，不需要了可以删', command: `git worktree remove ${quote(w.path)}` })
  }
  return { delete: del, keep, manual }
}

export interface CleanupResult {
  readonly deleted: readonly string[]
  readonly refused: readonly { readonly name: string, readonly reason: string }[]
}

/**
 * Delete the confirmed branches that are still safe now. The plan is rebuilt
 * from a fresh scan at the moment of acting: what the page showed may be stale,
 * so a name is deleted only if the operator confirmed it AND the current plan
 * still offers it. Callers that share the repository with a running loop hold
 * its state lock around this.
 */
export async function applyCleanup(root: string, confirmed: readonly string[], options: ScanOptions = {}): Promise<CleanupResult> {
  const plan = planCleanup(await scanRepo(root, options))
  const offered = new Set(plan.delete)
  const deleted: string[] = []
  const refused: { name: string, reason: string }[] = []
  for (const name of new Set(confirmed)) {
    if (!offered.has(name)) {
      refused.push({ name, reason: '现在已经不在可删除列表里（状态变了），没有删' })
      continue
    }
    try {
      await git(root, ['branch', '-d', '--', name])
      deleted.push(name)
    } catch (error) {
      refused.push({ name, reason: refusalReason(error) })
    }
  }
  return { deleted, refused }
}

/**
 * What git said, as a reason for the page. Never the raw message: execFile's
 * starts with the full command line, paths included, and stderr can name a
 * worktree's path.
 */
export function refusalReason(error: unknown): string {
  const stderr = String((error as { stderr?: unknown } | null)?.stderr ?? '')
  if (/not fully merged/.test(stderr)) return 'git 拒绝：分支没有完全合并'
  if (/(checked out|used by worktree)/.test(stderr)) return 'git 拒绝：分支被某个 worktree 检出'
  return 'git 拒绝删除这个分支'
}

function quote(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}
