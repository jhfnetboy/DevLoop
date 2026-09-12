import { execFile } from 'node:child_process'
import { homedir } from 'node:os'

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
  /** Which rules judged this change, for the PR log. */
  readonly checker: { readonly rulesVersion: string | null, readonly gitSha: string | null, readonly dirty: boolean | null } | null
  /** Why the checker could not say, when it could not. */
  readonly detail: string | null
}

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
  return { ...parsed, status: run.code === 1 ? 'blocked' : 'passed', detail: null }
}

/** True when every blocking finding is a size rule: splitting the task, not fixing it, is the answer. */
export function blockedOnlyBySize(result: PreprResult): boolean {
  const blocks = result.findings.filter(f => f.severity === 'block')
  return blocks.length > 0 && blocks.every(f => f.rule.startsWith('SZ-'))
}

function unavailable(detail: string): PreprResult {
  return { status: 'unavailable', findings: [], size: null, checker: null, detail }
}

function expandHome(part: string): string {
  return part === '~' || part.startsWith('~/') ? homedir() + part.slice(1) : part
}

interface Execution {
  readonly code: number | null
  readonly stdout: string
  readonly error: string | null
}

function execute(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<Execution> {
  // The checker reads the repository through git; nothing inherited may point it elsewhere.
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...env } = process.env
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
  const findings = raw.findings.slice(0, MAX_FINDINGS).flatMap((entry): PreprFinding[] => {
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
  const size = raw.size as { lines?: unknown, files?: unknown, counted_top_dirs?: unknown } | undefined
  const checker = raw.checker as { rules_version?: unknown, git_sha?: unknown, dirty?: unknown } | undefined
  return {
    findings,
    size: size && typeof size.lines === 'number' && typeof size.files === 'number'
      ? { lines: size.lines, files: size.files, countedTopDirs: Array.isArray(size.counted_top_dirs) ? size.counted_top_dirs.filter((d): d is string => typeof d === 'string') : [] }
      : null,
    checker: checker
      ? {
          rulesVersion: typeof checker.rules_version === 'string' ? checker.rules_version : null,
          gitSha: typeof checker.git_sha === 'string' ? checker.git_sha : null,
          dirty: typeof checker.dirty === 'boolean' ? checker.dirty : null,
        }
      : null,
  }
}
