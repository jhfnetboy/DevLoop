import { execFile } from 'node:child_process'
import { constants, lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { promisify } from 'node:util'

/**
 * Whether a repository is fit to start a loop in, checked before the first
 * dispatch rather than discovered at the first merge.
 *
 * Every check here is one the loop would otherwise hit after plan, delegate and
 * review had been paid for: the merge refuses a checkout with tracked changes,
 * and lands on whatever branch the checkout is on, locally, without pushing. So a
 * repository sitting on its trunk would have DevLoop commit straight into it,
 * which a repository run under the pilot skill forbids.
 *
 * Nothing here loads a skill. It reads what pilot leaves in the repository —
 * `.pilot.yml` and its planning directory — as plain files, and only reports
 * whether they are there; the planner reads them itself.
 */
export interface ReadinessCheck {
  readonly id: 'repo' | 'branch' | 'trunk' | 'clean' | 'pilot' | 'plan'
  readonly ok: boolean
  /** A failing blocking check refuses a start. The others are advice. */
  readonly blocking: boolean
  readonly message: string
}

export interface Readiness {
  /** Current branch; null on a detached HEAD. */
  readonly branch: string | null
  /** The trunk this repository merges into by PR. */
  readonly base: string
  /** Where pilot's planning documents live, relative to the root. */
  readonly docsDir: string
  readonly checks: readonly ReadinessCheck[]
  /** No blocking check failed. */
  readonly ready: boolean
}

const TRUNKS = new Set(['main', 'master'])
const DEFAULT_DOCS_DIR = 'docs/agent'
const PILOT_FILE = '.pilot.yml'
const PILOT_MAX_BYTES = 64 * 1024

export async function inspectReadiness(root: string): Promise<Readiness> {
  // Registration insists on a repository, so this is one deleted or moved since.
  // A readiness nobody could read must refuse, not wave the start through.
  if (!await isWorkTree(root)) {
    return {
      branch: null,
      base: 'main',
      docsDir: DEFAULT_DOCS_DIR,
      checks: [{ id: 'repo', ok: false, blocking: true, message: '读不到这个目录的 git 状态（仓库被删除或移走了？），不能启动。' }],
      ready: false,
    }
  }
  const pilot = await readPilotConfig(root)
  const branch = await currentBranch(root)
  const base = pilot?.baseBranch ?? await remoteDefaultBranch(root) ?? 'main'
  const docsDir = pilot?.docsDir ?? DEFAULT_DOCS_DIR
  const tracked = await trackedChanges(root)
  const checks: ReadinessCheck[] = []

  checks.push(branch === null
    ? { id: 'branch', ok: false, blocking: true, message: 'HEAD 是游离状态：DevLoop 会把任务合并到当前分支，而现在没有分支。先切到一个分支。' }
    : { id: 'branch', ok: true, blocking: true, message: `当前分支 ${branch}` })

  if (branch !== null) {
    const onTrunk = branch === base || TRUNKS.has(branch)
    checks.push(onTrunk
      ? {
          id: 'trunk',
          ok: false,
          blocking: true,
          message: `仓库停在 ${branch} 上，DevLoop 会把每个任务直接在本地合并进它。先切到一个工作分支，做完再用 PR 合回 ${base}：git -C ${shellQuote(root)} switch -c devloop/<目标名>`,
        }
      // Checked at start only: the merge itself has no trunk guard yet, so a
      // checkout switched back to a trunk mid-loop would still take the merges.
      : { id: 'trunk', ok: true, blocking: true, message: `（启动时）任务会合并到 ${branch}。循环运行中别把检出切回 ${[...new Set([base, ...TRUNKS])].join(' / ')}：合并时不会再检查分支。` })
  }

  checks.push(tracked === 0
    ? { id: 'clean', ok: true, blocking: true, message: '已跟踪的文件没有未提交的改动' }
    : { id: 'clean', ok: false, blocking: true, message: `有 ${tracked} 个已跟踪文件有未提交的改动，每次合并都会被拒绝（而那时规划、实现、评审的钱已经花了）。先提交或 stash。` })

  checks.push(pilot === null
    ? { id: 'pilot', ok: false, blocking: false, message: `没有 ${PILOT_FILE}，按 ${base} 当主干。建议先在 Claude Code 里跑 pilot status / pilot doctor：清理分支，并记下真实的主干。` }
    : { id: 'pilot', ok: true, blocking: false, message: `${PILOT_FILE}：主干 ${base}${pilot.planningSource === 'external' ? '，规划声明在仓库外' : ''}` })

  if (pilot?.planningSource === 'external') {
    checks.push({ id: 'plan', ok: true, blocking: false, message: '.pilot.yml 声明规划在仓库外：规划器只能参考 GOAL.md 和 AGENTS.md / CLAUDE.md' })
  } else {
    const found = await planningFiles(root, docsDir)
    checks.push(found.length > 0
      ? { id: 'plan', ok: true, blocking: false, message: `规划器会读 ${docsDir}/ 里的：${found.join('、')}` }
      : { id: 'plan', ok: false, blocking: false, message: `${docsDir}/ 里没有规划文档。pilot plan 会写出它们；没有的话规划器只能看 GOAL.md。` })
  }

  return { branch, base, docsDir, checks, ready: checks.every(check => check.ok || !check.blocking) }
}

/** The failing blocking checks, as one sentence for a refusal. */
export function readinessRefusal(readiness: Readiness): string | null {
  const failing = readiness.checks.filter(check => check.blocking && !check.ok)
  return failing.length === 0 ? null : failing.map(check => check.message).join(' ')
}

interface PilotConfig {
  readonly baseBranch: string | null
  readonly docsDir: string | null
  readonly planningSource: string | null
}

/**
 * The three scalar keys this needs, by line. Not a YAML parser, the same as
 * pilot's own scripts: a value that is not a plain token is ignored rather than
 * guessed at.
 */
export function parsePilotConfig(text: string): PilotConfig {
  const scalar = (key: string): string | null => {
    const match = new RegExp(`^${key}:[ \\t]*([^\\s#'"]+)[ \\t]*(?:#.*)?$`, 'm').exec(text)
    return match?.[1] ?? null
  }
  const branch = scalar('base_branch')
  const docs = scalar('docs_dir')
  return {
    baseBranch: branch !== null && /^[A-Za-z0-9._/-]+$/.test(branch) ? branch : null,
    docsDir: docs !== null && safeRelative(docs) ? normalize(docs).replace(/[/\\]+$/, '') : null,
    planningSource: scalar('planning_source'),
  }
}

function safeRelative(path: string): boolean {
  if (isAbsolute(path)) return false
  const normal = normalize(path)
  return normal !== '..' && !normal.startsWith(`..${sep}`) && !normal.split(sep).includes('..')
}

async function readPilotConfig(root: string): Promise<PilotConfig | null> {
  const text = await readPlain(join(root, PILOT_FILE), PILOT_MAX_BYTES)
  return text === null ? null : parsePilotConfig(text)
}

const PLANNING_FILES = ['roadmap.md', 'tasks.md', 'progress.md', 'architecture.md', 'spec.md', 'acceptance.md', 'research.md']

async function planningFiles(root: string, docsDir: string): Promise<string[]> {
  // A symlinked docs_dir must not turn this into a probe of paths outside the repository.
  let dir: string
  try {
    const top = await realpath(root)
    dir = await realpath(join(root, docsDir))
    if (dir !== top && !dir.startsWith(top + sep)) return []
  } catch {
    return []
  }
  const found: string[] = []
  for (const name of PLANNING_FILES) {
    try {
      const meta = await lstat(join(dir, name))
      if (meta.isFile() && meta.size > 0) found.push(name)
    } catch {
      // absent
    }
  }
  return found
}

/** A regular file, never through a symlink at the last hop, at most `max` bytes. */
async function readPlain(path: string, max: number): Promise<string | null> {
  try {
    const meta = await lstat(path)
    if (!meta.isFile()) return null
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const buffer = Buffer.alloc(Math.min(max, meta.size))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function isWorkTree(root: string): Promise<boolean> {
  try {
    return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

async function currentBranch(root: string): Promise<string | null> {
  try {
    const ref = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    return ref === '' ? null : ref
  } catch {
    return null
  }
}

async function remoteDefaultBranch(root: string): Promise<string | null> {
  try {
    const ref = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim()
    return ref.startsWith('origin/') ? ref.slice('origin/'.length) : null
  } catch {
    return null
  }
}

/** The same question the merge asks: tracked changes only, untracked files do not block it. */
async function trackedChanges(root: string): Promise<number> {
  const out = await git(root, ['status', '--porcelain', '--untracked-files=no'])
  return out.split('\n').filter(line => line.trim() !== '').length
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

const execFileAsync = promisify(execFile)

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    // A status for a web page must not take the index lock from a loop that is mid-merge.
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  return stdout
}
