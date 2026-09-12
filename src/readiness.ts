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
  // `--is-inside-work-tree` alone also answers true for a plain directory
  // inside some other repository, whose branch would then be reported as this
  // one's; only a root that is its own toplevel is a project.
  if (!await isToplevel(root)) {
    return {
      branch: null,
      base: 'main',
      docsDir: DEFAULT_DOCS_DIR,
      checks: [{ id: 'repo', ok: false, blocking: true, message: '这个目录不是一个 git 仓库的顶层（仓库被删除、移走，或它只是别的仓库里的子目录），不能启动。' }],
      ready: false,
    }
  }
  const pilot = await readPilotConfig(root)
  const branch = await currentBranch(root)
  const base = await baseBranch(root, pilot)
  const docsDir = pilot?.docsDir ?? DEFAULT_DOCS_DIR
  const tracked = await trackedChanges(root)
  const checks: ReadinessCheck[] = []

  checks.push(branch === null
    ? { id: 'branch', ok: false, blocking: true, message: 'HEAD 是游离状态：DevLoop 会把任务合并到当前分支，而现在没有分支。先切到一个分支。' }
    : { id: 'branch', ok: true, blocking: true, message: `当前分支 ${branch}` })

  if (branch !== null) {
    const trunks = trunkSet(base)
    checks.push(trunks.has(branch.toLowerCase())
      ? {
          id: 'trunk',
          ok: false,
          blocking: true,
          message: `仓库停在 ${branch} 上，DevLoop 会把每个任务直接在本地合并进它。先切到一个工作分支，做完再用 PR 合回 ${base}：git -C ${shellQuote(root)} switch -c devloop/<目标名>`,
        }
      // The merge checks the same set again (`trunkBranches`), so a checkout
      // switched back mid-loop halts the loop instead of taking the merge.
      : { id: 'trunk', ok: true, blocking: true, message: `任务会合并到 ${branch}。运行中如果检出被切回 ${[...trunks].join(' / ')}，合并前会停下来问你。` })
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

/**
 * The branches DevLoop never merges into: the configured base (`.pilot.yml`,
 * else `origin/HEAD`, else main) and, always, main and master. The start check
 * and the merge both ask this, so the rule cannot drift between them.
 */
export async function trunkBranches(root: string): Promise<ReadonlySet<string>> {
  return trunkSet(await baseBranch(root, await readPilotConfig(root)))
}

/**
 * Lower-cased: on a case-insensitive filesystem `Main` and `main` are one loose
 * ref, so a comparison by exact name would let `git switch Main` through.
 */
function trunkSet(base: string): ReadonlySet<string> {
  return new Set([base, ...TRUNKS].map(name => name.toLowerCase()))
}

export async function baseBranch(root: string, pilot: PilotConfig | null): Promise<string> {
  return pilot?.baseBranch ?? await remoteDefaultBranch(root) ?? 'main'
}

/** The failing blocking checks, as one sentence for a refusal. */
export function readinessRefusal(readiness: Readiness): string | null {
  const failing = readiness.checks.filter(check => check.blocking && !check.ok)
  return failing.length === 0 ? null : failing.map(check => check.message).join(' ')
}

export interface PilotConfig {
  readonly baseBranch: string | null
  readonly docsDir: string | null
  readonly planningSource: string | null
  /** Branch-name prefixes never deleted; always includes pilot's floor. */
  readonly protectPatterns: readonly string[]
  /** Entries of protect_patterns that protect nothing, with why. */
  readonly protectDropped: readonly ProtectDrop[]
}

/**
 * pilot's floor: a config can only add to it, never remove from it — a file
 * that is present, parses, and merely lacks a line must not protect less than
 * no file at all.
 */
export const PROTECT_FLOOR: readonly string[] = ['release', 'hotfix', 'deploy']

/**
 * The scalar keys this needs, by line, and `protect_patterns` (see
 * `protectList`). Not a YAML parser, the same as pilot's own scripts: a scalar
 * that is not a plain token is ignored rather than guessed at. CRLF files read
 * the same as LF ones.
 */
export function parsePilotConfig(source: string): PilotConfig {
  const text = source.replace(/\r/g, '')
  const scalar = (key: string): string | null => {
    const match = new RegExp(`^${key}:[ \\t]*([^\\s#'"]+)[ \\t]*(?:#.*)?$`, 'm').exec(text)
    return match?.[1] ?? null
  }
  const branch = scalar('base_branch')
  const docs = scalar('docs_dir')
  const protect = protectList(text)
  return {
    baseBranch: branch !== null && /^[A-Za-z0-9._/-]+$/.test(branch) ? branch : null,
    docsDir: docs !== null && safeRelative(docs) ? normalize(docs).replace(/[/\\]+$/, '') : null,
    planningSource: scalar('planning_source'),
    protectPatterns: [...new Set([...PROTECT_FLOOR, ...protect.items])],
    protectDropped: protect.dropped,
  }
}

/**
 * A deny-list, so reading less than pilot's ref hook would protect less than
 * the hook does. This reads a superset of what the hook's awk reads: CRLF is
 * normalized; inside a block list, blank and comment lines are skipped and a
 * `- x` item counts at any indentation; only a new top-level key ends the list;
 * items are cleaned as the hook cleans them. What is still not a branch name is
 * returned, not silently dropped.
 */
function protectList(text: string): { items: string[], dropped: ProtectDrop[] } {
  const lines = text.replace(/\r/g, '').split('\n')
  const at = lines.findIndex(line => line.startsWith('protect_patterns:'))
  const raw: string[] = []
  if (at >= 0) {
    const rest = (lines[at] ?? '').slice('protect_patterns:'.length)
    const flow = /^[ \t]*\[([^\]]*)\]/.exec(rest)
    if (flow) raw.push(...(flow[1] ?? '').split(','))
    else {
      for (const line of lines.slice(at + 1)) {
        const item = /^[ \t]*-(.*)$/.exec(line)
        if (item) raw.push(item[1] ?? '')
        else if (/^[^ \t#]/.test(line)) break
      }
    }
  }
  const items: string[] = []
  const dropped: ProtectDrop[] = []
  for (const entry of raw) {
    const item = entry.replace(/\s*#.*$/, '').trim().replace(/^["']/, '').replace(/["']$/, '')
    if (item === '') continue
    if (isBranchName(item)) items.push(item)
    else dropped.push({ item, reason: /[*?[]/.test(item) ? '通配符不起作用：保护按字面前缀匹配' : '不是合法的分支名' })
  }
  return { items, dropped }
}

export interface ProtectDrop {
  readonly item: string
  readonly reason: string
}

/** `git check-ref-format --branch`'s rules, which admit non-ASCII and `+`. */
function isBranchName(name: string): boolean {
  if (name.startsWith('-') || name.endsWith('/') || name.endsWith('.') || name === '@') return false
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false
  return name.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
}

/**
 * The protected prefixes for a repository: `.pilot.yml`'s list unioned with the
 * floor, or the floor alone when there is no file (or it is unreadable). The
 * one place the union is made, so no caller can build a list without the floor.
 */
export async function protectedPrefixes(root: string): Promise<{ readonly patterns: readonly string[], readonly dropped: readonly ProtectDrop[] }> {
  const pilot = await readPilotConfig(root)
  return { patterns: pilot?.protectPatterns ?? PROTECT_FLOOR, dropped: pilot?.protectDropped ?? [] }
}

function safeRelative(path: string): boolean {
  if (isAbsolute(path)) return false
  const normal = normalize(path)
  return normal !== '..' && !normal.startsWith(`..${sep}`) && !normal.split(sep).includes('..')
}

export async function readPilotConfig(root: string): Promise<PilotConfig | null> {
  const text = await readPlain(join(root, PILOT_FILE), PILOT_MAX_BYTES)
  return text === null ? null : parsePilotConfig(text)
}

const PLANNING_FILES = ['roadmap.md', 'tasks.md', 'progress.md', 'acceptance.md', 'architecture.md', 'spec.md', 'research.md']
const DOCUMENT_MAX_BYTES = 64 * 1024

export interface PlanningDocument {
  /** Path relative to the repository root, for display. */
  readonly path: string
  readonly name: string
  readonly text: string
  /** Longer than was read; the page says so rather than showing a silent cut. */
  readonly truncated: boolean
}

/**
 * pilot's planning documents, for the page to show. Only the known file names,
 * only regular files, never through a symlink at the last hop, and only inside
 * the repository: this is how a registered project's plan is read, not a way to
 * read an arbitrary file.
 */
export async function readPlanningDocuments(root: string): Promise<{ readonly docsDir: string, readonly documents: readonly PlanningDocument[] }> {
  const pilot = await readPilotConfig(root)
  const docsDir = pilot?.docsDir ?? DEFAULT_DOCS_DIR
  const dir = await containedDir(root, docsDir)
  if (dir === null) return { docsDir, documents: [] }
  const documents: PlanningDocument[] = []
  for (const name of PLANNING_FILES) {
    const path = join(dir, name)
    let size: number
    try {
      const meta = await lstat(path)
      if (!meta.isFile() || meta.size === 0) continue
      size = meta.size
    } catch {
      continue
    }
    const text = await readPlain(path, DOCUMENT_MAX_BYTES)
    if (text !== null) documents.push({ path: `${docsDir}/${name}`, name, text, truncated: size > DOCUMENT_MAX_BYTES })
  }
  return { docsDir, documents }
}

/** The realpath of `relative` under `root`, or null when it is missing or resolves outside. */
async function containedDir(root: string, relative: string): Promise<string | null> {
  try {
    const top = await realpath(root)
    const dir = await realpath(join(root, relative))
    return dir === top || dir.startsWith(top + sep) ? dir : null
  } catch {
    return null
  }
}

async function planningFiles(root: string, docsDir: string): Promise<string[]> {
  // A symlinked docs_dir must not turn this into a probe of paths outside the repository.
  const dir = await containedDir(root, docsDir)
  if (dir === null) return []
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

export async function isToplevel(root: string): Promise<boolean> {
  try {
    const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
    return top !== '' && await realpath(top) === await realpath(root)
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

export async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    // A status for a web page must not take the index lock from a loop that is mid-merge.
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  return stdout
}
