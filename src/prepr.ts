import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { taskGitEnv } from './worktree.js'

/**
 * PR-daemon's mechanical pre-PR rules, run against one task's change.
 *
 * The rules — the per-PR size budget among them — live in the PR-daemon
 * repository and are only called from here, never copied: a copy would drift
 * from the one the reviewer applies, and a rule change there must reach every
 * loop without a DevLoop release. So this module knows the checker's contract
 * (argv, exit codes, JSON) and nothing about any rule.
 */
export interface PreprFinding {
  readonly rule: string
  readonly file: string | null
  readonly line: number | null
  readonly message: string
  /** `block` refuses the change; anything else is for the PR body. */
  readonly severity: string
}

export interface PreprResult {
  /** `unavailable` is never a pass: the checker could not say. */
  readonly status: 'passed' | 'blocked' | 'unavailable'
  readonly findings: readonly PreprFinding[]
  readonly size: { readonly lines: number, readonly files: number, readonly countedTopDirs: readonly string[] } | null
  /**
   * Where the size falls against the budget: `elastic` is over the budget but
   * reviewable, `over` is refused. Null when the checker could not say.
   */
  readonly band: SizeBand | null
  /** The budget the checker applied (`max_lines`, `elastic_lines`, …), when it names it. */
  readonly limits: Readonly<Record<string, number>> | null
  /** Which rules judged this change, for the PR log. */
  readonly checker: { readonly rulesVersion: string | null, readonly gitSha: string | null, readonly dirty: boolean | null } | null
  /** Why the checker could not say, when it could not. */
  readonly detail: string | null
}

export type SizeBand = 'normal' | 'elastic' | 'over'
const BANDS = new Set<string>(['normal', 'elastic', 'over'])

const MAX_FINDINGS = 200
const MAX_TEXT = 500
const MAX_OUTPUT = 4 * 1024 * 1024

/**
 * Run the checker as `argv --base <sha> --repo <worktree> --profile <p> --json-only`.
 * Exit 0 is a pass, exit 1 with a blocking finding is a block, and everything
 * else — exit 2, a timeout, a missing command, output that is not the JSON —
 * is `unavailable`.
 */
export async function runPreprCheck(
  argv: readonly string[],
  profile: string,
  worktreeRoot: string,
  baseSha: string,
  timeoutMs: number,
): Promise<PreprResult> {
  const [command, ...args] = argv.map(expandHome)
  if (command === undefined) return unavailable('no checker configured')
  const run = await execute(command, [...args, '--base', baseSha, '--repo', worktreeRoot, '--profile', profile, '--json-only'], worktreeRoot, timeoutMs)
  if (run.error !== null) return unavailable(run.error)
  if (run.code !== 0 && run.code !== 1) return unavailable(`checker exited ${String(run.code)}`)
  const parsed = parseOutput(run.stdout)
  if (parsed === null) return unavailable('checker output is not the expected JSON')
  const blocks = parsed.findings.filter(f => f.severity === 'block')
  if (run.code === 1 && blocks.length === 0) return unavailable('checker exited 1 without a blocking finding')
  if (run.code === 0 && blocks.length > 0) return unavailable('checker exited 0 with a blocking finding')
  // A checker older than the band says only whether a size rule blocked.
  const sizeBlocked = blocks.some(isBandRule)
  const band = parsed.band ?? (sizeBlocked ? 'over' : 'normal')
  // Only this direction is impossible: a profile whose size rules are notes reports `over` without blocking.
  if (band !== 'over' && sizeBlocked) return unavailable(`checker put the size in the ${band} band but blocked it on size`)
  return { ...parsed, band, status: run.code === 1 ? 'blocked' : 'passed', detail: null }
}

/** True when every blocking finding is a size rule: splitting the task, not fixing it, is the answer. */
export function blockedOnlyBySize(result: PreprResult): boolean {
  const blocks = result.findings.filter(f => f.severity === 'block')
  return blocks.length > 0 && blocks.every(isBandRule)
}

/**
 * The rules the band measures: lines, files, directories. SZ-4 (high-risk
 * content mixed with other changes) is not one — it blocks in every band, and
 * its answer is to move those files out, not to make the change smaller.
 */
function isBandRule(finding: PreprFinding): boolean {
  return /^SZ-[123]$/.test(finding.rule)
}

function unavailable(detail: string): PreprResult {
  return { status: 'unavailable', findings: [], size: null, band: null, limits: null, checker: null, detail }
}

function expandHome(part: string): string {
  return part === '~' || part.startsWith('~/') ? homedir() + part.slice(1) : part
}

interface Execution {
  readonly code: number | null
  readonly stdout: string
  readonly error: string | null
}

async function execute(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<Execution> {
  // The checker reads the repository through git; nothing inherited may point it elsewhere, and in a
  // task worktree the host's own paths are pinned so a rewritten commondir cannot either.
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, GIT_COMMON_DIR: _common, ...inherited } = process.env
  let pinned: Record<string, string> | null
  try {
    pinned = await taskGitEnv(cwd)
  } catch (error) {
    return { code: null, stdout: '', error: error instanceof Error ? error.message : 'worktree gitdir check failed' }
  }
  const env = { ...inherited, ...pinned, GIT_CONFIG_PARAMETERS: "'core.fsmonitor=false'" }
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env, encoding: 'utf8' }, (error, stdout) => {
      if (error === null) return resolve({ code: 0, stdout, error: null })
      const failure = error as NodeJS.ErrnoException & { code?: number | string, killed?: boolean }
      if (failure.killed) return resolve({ code: null, stdout, error: 'checker timed out' })
      if (typeof failure.code === 'number') return resolve({ code: failure.code, stdout, error: null })
      resolve({ code: null, stdout, error: `checker could not run (${String(failure.code ?? 'error')})` })
    })
  })
}

function parseOutput(stdout: string): Omit<PreprResult, 'status' | 'detail'> | null {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { findings?: unknown }).findings)) return null
  const raw = value as { findings: unknown[], size?: unknown, checker?: unknown }
  // Capped after parsing, blocking findings first: a cap taken before counting would drop the
  // one block among hundreds of review notes and misread the run as having no verdict.
  const parsed = raw.findings.flatMap((entry): PreprFinding[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const f = entry as Record<string, unknown>
    if (typeof f.rule !== 'string' || typeof f.severity !== 'string') return []
    return [{
      rule: f.rule.slice(0, 32),
      file: typeof f.file === 'string' ? f.file.slice(0, MAX_TEXT) : null,
      line: typeof f.line === 'number' && Number.isInteger(f.line) ? f.line : null,
      message: typeof f.message === 'string' ? f.message.slice(0, MAX_TEXT) : '',
      severity: f.severity,
    }]
  })
  const findings = [...parsed.filter(f => f.severity === 'block'), ...parsed.filter(f => f.severity !== 'block')].slice(0, MAX_FINDINGS)
  const size = raw.size as { lines?: unknown, files?: unknown, counted_top_dirs?: unknown, band?: unknown, limits?: unknown } | undefined
  const checker = raw.checker as { rules_version?: unknown, git_sha?: unknown, dirty?: unknown } | undefined
  return {
    findings,
    size: size && typeof size.lines === 'number' && typeof size.files === 'number'
      ? { lines: size.lines, files: size.files, countedTopDirs: Array.isArray(size.counted_top_dirs) ? size.counted_top_dirs.filter((d): d is string => typeof d === 'string') : [] }
      : null,
    band: typeof size?.band === 'string' && BANDS.has(size.band) ? size.band as SizeBand : null,
    limits: limitsOf(size?.limits),
    checker: checker
      ? {
          rulesVersion: typeof checker.rules_version === 'string' ? checker.rules_version : null,
          gitSha: typeof checker.git_sha === 'string' ? checker.git_sha : null,
          dirty: typeof checker.dirty === 'boolean' ? checker.dirty : null,
        }
      : null,
  }
}

function limitsOf(value: unknown): Readonly<Record<string, number>> | null {
  if (typeof value !== 'object' || value === null) return null
  const entries = Object.entries(value).filter(([key, n]) => /^[a-z_]{1,32}$/.test(key) && typeof n === 'number' && Number.isFinite(n))
  return entries.length > 0 ? Object.fromEntries(entries.slice(0, 16)) : null
}
