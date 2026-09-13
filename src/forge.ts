import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import { parseDevloopResult, resultInstructions, type ReviewResult } from './result.js'
import { defaultRunner, RUNNER_REAP_MS, type HeadlessRunner } from './spawn.js'
import { WORKTREE_BRANCH_PREFIX, worktreeTaskToken } from './worktree.js'

const GIT_TIMEOUT_MS = 60_000
const FORGE_TIMEOUT_MS = 60_000
const PUSH_TIMEOUT_MS = 10 * 60_000
/** A merge only re-reads and merges; it never waits for a person. */
const MERGE_BUDGET_MS = 5 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 30_000
/** Node clamps a longer delay to 1ms, so a larger wait would silently busy-poll. */
const MAX_TIMER_MS = 2_147_483_647
/** Named by this code, so a hostile URL can never be mistaken for a remote name. */
const TARGET_REMOTE = 'devloop-target'
/** Every pull request DevLoop opens carries it, so PR-daemon's fixer leaves them to DevLoop. */
export const DEVLOOP_LABEL = 'devloop'
/**
 * A hard ceiling on the thread, not a window: discarding older comments would
 * let a flood of filler bury an objection behind a newer approval, so a thread
 * past this size fails closed instead.
 */
export const MAX_REVIEW_COMMENTS = 2_000
/** A review body kept as rework notes, capped like a result envelope's notes. */
const MAX_NOTES = 8_000
const SHA = /^[0-9a-f]{40}$/i
/** GitHub logins are 39 chars of alphanumerics and hyphens; apps add a [bot] suffix. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/
const BRANCH_CHARS = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

/** The subset of `git check-ref-format --branch` a plain regex misses. */
export function isValidBranchName(name: string): boolean {
  if (!BRANCH_CHARS.test(name)) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  return name.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}
const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/

/**
 * Git runs repository-controlled hooks and fsmonitor with this host's privileges,
 * so every invocation here disables both and refuses to prompt, matching the hardening
 * `worktree.ts` applies to its own git calls.
 */
const GIT_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'
/**
 * The only inherited variables a forge child keeps.
 *
 * This is an allowlist on purpose. Two rounds of review found a denylist losing
 * to a name it did not know about — first `GIT_CONFIG_PARAMETERS`, then
 * `XDG_CONFIG_HOME` — and the set of variables that can point git or gh at
 * someone else's configuration, helper binary, or transport is not one this
 * code can enumerate. Everything here is either required to reach the forge at
 * all or is the operator's own credential material.
 *
 * Deliberately absent: `XDG_CONFIG_HOME` and `GH_CONFIG_DIR`, which relocate
 * git and gh configuration; `SSH_ASKPASS` and friends, which name a program to
 * run; and `GH_FORCE_TTY`, which reformats the JSON this code parses. Git
 * global config is still read through `HOME`, so a credential helper in
 * `~/.gitconfig` keeps working; one kept only under `$XDG_CONFIG_HOME` does not.
 */
const INHERITED_ENV: readonly string[] = [
  // Reaching the binaries at all.
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  // The operator's own identity and credentials.
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USER', 'LOGNAME', 'SHELL',
  'SSH_AUTH_SOCK',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  // Reaching a forge from behind a corporate proxy. Same trust as PATH: set by
  // whoever launched the loop, not by anything in the workspace.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  // Locale and scratch space, so git and gh behave normally.
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
]

const INHERITED = new Set(INHERITED_ENV.map(name => name.toUpperCase()))

/**
 * Names to drop from a forge child: everything the allowlist above does not
 * name. Windows environment names are case-insensitive, so the comparison is.
 */
export function scrubbedEnvNames(source: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(source).filter(name => !INHERITED.has(name.toUpperCase()))
}

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  // Repository config can name an ssh binary; the environment outranks it.
  GIT_SSH_COMMAND: 'ssh',
  GIT_ASKPASS: '',
}

export interface ForgeOptions {
  /**
   * Canonical push URL, taken from DevLoop configuration only.
   *
   * The workspace's own remotes are never consulted: `git remote get-url`
   * applies repository-local `url.*.pushInsteadOf`, so a checkout could hand
   * back an already-retargeted URL that every later check would agree with.
   * The host that URL names is also the identity namespace `reviewers` is
   * interpreted in, so it must not be attacker-selectable.
   */
  readonly pushUrl: string
  /** Pull request base branch. */
  readonly base: string
  /** Forge CLI. Only the GitHub CLI (`gh`) is supported today. */
  readonly command: string
  /** GitHub logins allowed to decide this task. A verdict from anyone else is ignored. */
  readonly reviewers: readonly string[]
  /** Gap between verdict polls while the pull request is open. */
  readonly pollIntervalMs: number
  /** Upper bound on one wait. 0 takes the bound from the task contract. */
  readonly maxWaitMs: number
  /**
   * Where the verdict comes from: GitHub's own reviews on the pull request
   * (APPROVED, CHANGES_REQUESTED), or a comment carrying a `<devloop_result>`
   * envelope. Exactly one is read, so the two can never disagree.
   */
  readonly verdictSource: 'reviews' | 'comments'
  /**
   * Whether a commit must report at least one check before its checks count as
   * green. Off, a repository with no CI passes; on, a commit that reports none
   * yet (CI not configured, or not registered right after a push) keeps waiting.
   */
  readonly requireChecks: boolean
}

export const DEFAULT_FORGE_OPTIONS: ForgeOptions = {
  pushUrl: '',
  base: 'main',
  command: 'gh',
  reviewers: [],
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxWaitMs: 0,
  verdictSource: 'reviews',
  requireChecks: false,
}

export function assertForgeOptions(options: ForgeOptions): void {
  for (const name of ['base', 'command'] as const) {
    const value = options[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`forge_config: ${name} must be a non-empty string`)
    }
    // A value that parses as an option would smuggle flags into git/gh argv.
    if (value.startsWith('-')) throw new Error(`forge_config: ${name} must not start with "-"`)
  }
  if (typeof options.pushUrl !== 'string') throw new Error('forge_config: pushUrl must be a string')
  if (options.pushUrl.startsWith('-')) throw new Error('forge_config: pushUrl must not start with "-"')
  // Empty is allowed at construction so an unused forge route need not be configured;
  // a review refuses without it.
  if (options.pushUrl.length > 0) parseRemoteUrl(options.pushUrl)
  if (!isValidBranchName(options.base)) throw new Error('forge_config: base is not a valid branch name')
  if (!Array.isArray(options.reviewers)) throw new Error('forge_config: reviewers must be a list')
  for (const login of options.reviewers) {
    if (typeof login !== 'string' || !LOGIN.test(login)) {
      throw new Error(`forge_config: reviewers contains an invalid login ${String(login)}`)
    }
  }
  for (const name of ['pollIntervalMs', 'maxWaitMs'] as const) {
    const value = options[name]
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_MS) {
      throw new Error(`forge_config: ${name} must be an integer between 0 and ${MAX_TIMER_MS}`)
    }
  }
  if (typeof options.requireChecks !== 'boolean') throw new Error('forge_config: requireChecks must be true or false')
  if (options.pollIntervalMs <= 0) throw new Error('forge_config: pollIntervalMs must be positive')
}

export interface ForgeRepo {
  readonly host: string
  readonly owner: string
  readonly name: string
}

/** `gh --repo` accepts HOST/OWNER/REPO; dropping the host would silently retarget github.com. */
export function repoSlug(repo: ForgeRepo): string {
  return `${repo.host}/${repo.owner}/${repo.name}`
}

/**
 * Derive the exact repository a push URL targets. `gh` otherwise picks a
 * repository from the checkout or `GH_REPO`, which need not be the one that
 * just received the branch.
 */
/**
 * Hide anything between the scheme and the host before a URL reaches an error
 * message. `forge_remote:` failures are logged by the service, and a push URL
 * carrying `user:token@` would put that token in the log.
 */
export function maskUrl(url: string): string {
  const scheme = url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, '$1***@')
  if (scheme !== url) return scheme
  // The scp form has no scheme, and git accepts `user:secret@host:path` there,
  // parsing the whole `user:secret` as the ssh user.
  return url.replace(/^[^/@]*:[^/@]*@/, '***@')
}

/**
 * An SSH URL conventionally carries a user name (`ssh://git@host/...`), which is
 * not a secret. Anything else in the userinfo is: a password, or a token in the
 * `https://TOKEN@host/...` form. Those belong in a credential helper, not in
 * configuration that is passed on an argv and echoed in errors.
 */
function assertNoEmbeddedCredential(url: string): void {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)@/.exec(url)
  if (match) {
    const scheme = (match[1] ?? '').toLowerCase()
    const userinfo = match[2] ?? ''
    if (userinfo.includes(':') || scheme === 'http' || scheme === 'https') {
      throw new Error(`forge_remote: remote URL must not embed credentials (${maskUrl(url)})`)
    }
    return
  }
  // Scheme-less scp form. `git@host:path` is the ordinary shape and carries no
  // secret. `user:secret@host:path` is refused because the secret would still be
  // stored in config, passed on an argv and echoed in errors — not because it
  // reaches the intended host. Measured with an ssh stub that prints argv to
  // stderr, git splits at the first colon and dials a host literally named
  // `user`:
  //   user:tok@example.invalid:owner/repo.git
  //     -> ssh "user" git-upload-pack 'tok@example.invalid:owner/repo.git'
  //   git@example.invalid:owner/repo.git
  //     -> ssh "git@example.invalid" git-upload-pack 'owner/repo.git'
  if (/^[^/@]*:[^/@]*@/.test(url)) {
    throw new Error(`forge_remote: remote URL must not embed credentials (${maskUrl(url)})`)
  }
}

export function parseRemoteUrl(url: string): ForgeRepo {
  const trimmed = url.trim()
  if (trimmed.length === 0) throw new Error('forge_remote: remote has no push URL')
  assertNoEmbeddedCredential(trimmed)
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(trimmed)
  const path = scp
    ? { host: scp[1] ?? '', rest: scp[2] ?? '' }
    : parseUrlForm(trimmed)
  // Exactly OWNER/REPO[.git]: anything else is not something `gh --repo
  // HOST/OWNER/REPO` can name, so the push and the API would disagree.
  const segments = path.rest.replace(/^\/+/, '').replace(/\.git$/, '').split('/')
  if (segments.length !== 2) throw new Error(`forge_remote: cannot read owner/name from ${maskUrl(trimmed)}`)
  const owner = segments[0] ?? ''
  const name = segments[1] ?? ''
  if (!HOSTNAME.test(path.host)) throw new Error(`forge_remote: invalid host in ${maskUrl(trimmed)}`)
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) {
    throw new Error(`forge_remote: invalid owner/name in ${maskUrl(trimmed)}`)
  }
  return { host: path.host, owner, name }
}

function parseUrlForm(raw: string): { host: string; rest: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`forge_remote: unsupported remote URL ${maskUrl(raw)}`)
  }
  // URL drops :443 and :80 during normalization, so read the port off the raw
  // authority instead: `gh --repo` cannot carry one either way.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@]*@?[^/:]+:[0-9]/.test(raw)) {
    throw new Error(`forge_remote: remote URL with a port is not supported (${maskUrl(raw)})`)
  }
  if (!['ssh:', 'git:', 'http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`forge_remote: unsupported remote protocol ${parsed.protocol}`)
  }
  return { host: parsed.hostname, rest: parsed.pathname }
}

/** One dispatch's hard deadline, applied to every child process and every sleep. */
interface RunCtx {
  readonly deadline: number
  readonly budgetMs: number
  readonly signal?: AbortSignal
  /** This pull request's base: the loop's work branch, or the configured base without one. */
  readonly base?: string
  /** Set when `base` is the loop's work branch rather than the configured fallback. */
  readonly onWorkBranch?: boolean
}

export interface ForgeVerdict {
  readonly result: ReviewResult
  readonly author: string
}

interface PullRequest {
  readonly number: number
  readonly baseRefName: string
  readonly headRefName: string
  readonly headRefOid: string
  readonly isCrossRepository: boolean
}

const PR_FIELDS = 'number,baseRefName,headRefName,headRefOid,isCrossRepository'

/**
 * Review through a pull request instead of a local reviewer process.
 *
 * The reviewed commit is published, a pull request is opened (or reused), and
 * the verdict is read back from a PR comment carrying the same
 * `<devloop_result>` envelope the CLI reviewers emit.
 *
 * The wait happens inside this run, not across ticks. `runTick` latches a
 * repeated work action whose task has not changed, so a review that returned
 * without a verdict is never dispatched a second time; polling from the outer
 * loop would ask the forge exactly once. One dispatch therefore polls until a
 * verdict lands, the task's own time budget runs out, or the host aborts. The
 * loop already runs at most one dispatch at a time, so this waits in the slot
 * the review already owns rather than taking a new one.
 *
 * Everything a verdict is trusted for is re-established on every poll: the
 * repository comes from the push URL of the configured remote rather than from
 * `gh`'s own repository guess, and the pull request must still be same-repo and
 * still point its head at the exact reviewed commit. Authors must be on the
 * configured allowlist and must not be the account this host authenticates as.
 * Any dissenting verdict for that commit vetoes an approval, and a wait that
 * ends without one fails rather than inventing it.
 */
export class ForgePrBackend implements AgentBackend {
  private readonly options: ForgeOptions

  constructor(options: Partial<ForgeOptions> = {}, private readonly runner: HeadlessRunner = defaultRunner) {
    this.options = { ...DEFAULT_FORGE_OPTIONS, ...options }
    assertForgeOptions(this.options)
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (input.action.type !== 'review') {
      return { status: 'failed', detail: 'forge_role: this backend only serves review', reachedProvider: false }
    }
    const contract = input.contract
    if (!contract) return { status: 'failed', detail: 'forge_input: review needs a task contract', reachedProvider: false }
    const token = worktreeTaskToken(contract.taskId)
    if (!token) return { status: 'failed', detail: 'forge_input: unsafe task id', reachedProvider: false }
    const sha = contract.implementationSha
    if (sha === undefined || !SHA.test(sha)) {
      return { status: 'failed', detail: 'forge_input: review needs an implementation SHA', reachedProvider: false }
    }
    if (this.options.reviewers.length === 0) {
      return { status: 'failed', detail: 'forge_config: reviewers must list at least one authorized login', reachedProvider: false }
    }
    if (this.options.pushUrl.length === 0) {
      return { status: 'failed', detail: 'forge_config: pushUrl must name the repository to publish to', reachedProvider: false }
    }
    // A task's pull request targets the loop's work branch; trunk only ever receives the release pull request.
    const base = input.workBranch ?? this.options.base
    if (!isValidBranchName(base)) {
      return { status: 'failed', detail: 'forge_input: the work branch is not a valid branch name', reachedProvider: false }
    }
    const workBase = input.workBranch === undefined ? null : contract.baseSha?.toLowerCase()
    if (input.workBranch !== undefined && base.toLowerCase() === this.options.base.toLowerCase()) {
      return { status: 'failed', detail: 'forge_input: the work branch is the trunk', reachedProvider: false }
    }
    if (workBase !== null && (workBase === undefined || !SHA.test(workBase))) {
      return { status: 'failed', detail: 'forge_input: targeting a work branch needs the task\'s base commit', reachedProvider: false }
    }

    const branch = `${WORKTREE_BRANCH_PREFIX}${token}`
    const reviewed = sha.toLowerCase()
    // `git -C <root>` with cwd also at <root> would resolve a relative root
    // twice, and a relative alternates path would not resolve at all.
    const workspaceRoot = resolve(input.workspaceRoot)
    // One deadline for the whole dispatch, started before any setup work: the
    // loop granted this run a slot of that length, and publishing must not be
    // able to overrun it before polling has even begun.
    const budgetMs = Math.min(
      this.options.maxWaitMs > 0 ? this.options.maxWaitMs : contract.budget.maxMinutes * 60_000,
      MAX_TIMER_MS,
    )
    const deadline = Date.now() + budgetMs
    const ctx: RunCtx = { deadline, budgetMs, base, onWorkBranch: input.workBranch !== undefined, ...(input.signal === undefined ? {} : { signal: input.signal }) }
    try {
      // Trusted configuration, not the checkout, decides where this goes.
      const url = this.options.pushUrl
      const repo = parseRemoteUrl(url)
      // Identity is read once per dispatch and scoped to this repository's host,
      // never cached across runs where the logged-in account may have changed.
      const self = await this.authenticatedLogin(workspaceRoot, repo, ctx)
      if (input.workBranch !== undefined) {
        // Tasks are cut from, and followed into, the checkout: one moved off the work branch would split the two.
        const head = (await this.git(workspaceRoot, ['symbolic-ref', '--quiet', 'HEAD'], ctx).catch(() => '')).trim()
        if (head !== `refs/heads/${base}`) {
          return { status: 'failed', detail: `forge_input: the checkout is on ${head || 'a detached HEAD'}, not the work branch ${base}`, reachedProvider: false }
        }
      }
      await this.publish(workspaceRoot, url, branch, reviewed, ctx, workBase === null ? null : { branch: base, sha: workBase })
      const number = await this.ensurePullRequest(workspaceRoot, repo, branch, reviewed, contract, ctx)

      const ranOut = {
        status: 'failed' as const,
        detail: `forge_timeout: pull request ${number} had no verdict within ${minutes(budgetMs)} minutes`,
      }
      for (;;) {
        let verdict: ForgeVerdict | null
        try {
          verdict = await this.readVerdict(workspaceRoot, repo, number, branch, contract.taskId, reviewed, self, ctx)
        } catch (error) {
          // Once the pull request is known, running out of budget is reported
          // against it rather than as a bare setup timeout.
          if (error instanceof Error && error.message.startsWith('forge_timeout:')) return ranOut
          throw error
        }
        if (verdict) {
          return { status: 'started', outcome: verdict.result, agent: `github:${verdict.author}` }
        }
        if (input.signal?.aborted) throw new Error('backend timeout')
        const left = deadline - Date.now()
        if (left <= 0) return ranOut
        // Never skip the tail of the window: a poll gap wider than the time left
        // would otherwise end the review a whole interval early.
        await sleep(Math.min(this.options.pollIntervalMs, left), input.signal)
      }
    } catch (error) {
      return { status: 'failed', detail: error instanceof Error ? error.message : 'forge failed' }
    }
  }

  /**
   * Merge a task's approved pull request into the loop's work branch, as the
   * account this host authenticates as, and return the merge commit.
   *
   * Everything the review established is established again first, because time
   * has passed: the pull request is still same-repo, still based on the work
   * branch and still headed at the reviewed commit, its reviews still pass
   * that commit and its checks are still green. `--match-head-commit` makes
   * GitHub refuse if the head moves in between. `gh` runs from an empty
   * directory, so it never touches the checkout. A pull request already merged
   * at the reviewed commit is not merged again: a host that merged it and then
   * failed before recording that picks up the merge commit it made.
   */
  async mergeTask(request: { workspaceRoot: string, taskId: string, sha: string, workBranch: string, signal?: AbortSignal }): Promise<{ number: number, mergeCommit: string, mergedBy?: string }> {
    const token = worktreeTaskToken(request.taskId)
    const sha = request.sha.toLowerCase()
    if (!token || !SHA.test(sha)) throw new Error('forge_merge: needs a safe task id and the reviewed commit')
    if (!isValidBranchName(request.workBranch) || request.workBranch.toLowerCase() === this.options.base.toLowerCase()) {
      throw new Error('forge_merge: the work branch is missing, invalid or the trunk')
    }
    if (this.options.reviewers.length === 0 || this.options.pushUrl.length === 0) throw new Error('forge_merge: forge is not configured to decide or merge')
    const branch = `${WORKTREE_BRANCH_PREFIX}${token}`
    const root = resolve(request.workspaceRoot)
    const ctx: RunCtx = { deadline: Date.now() + MERGE_BUDGET_MS, budgetMs: MERGE_BUDGET_MS, base: request.workBranch, ...(request.signal === undefined ? {} : { signal: request.signal }) }
    const repo = parseRemoteUrl(this.options.pushUrl)
    const self = await this.authenticatedLogin(root, repo, ctx)
    const found = await this.pullRequestOf(root, repo, branch, request.workBranch, sha, ctx)
    if (found.state === 'MERGED') {
      // Found merged: this host's own earlier attempt, cut short before it was recorded, or someone
      // else's Merge, which skipped the re-check below. Only the second is worth the operator's notice.
      const outside = found.mergedBy !== null && found.mergedBy.toLowerCase() !== self.toLowerCase()
      return { number: found.number, mergeCommit: found.mergeCommit, ...(outside && found.mergedBy !== null ? { mergedBy: found.mergedBy } : {}) }
    }
    // The same reading the review made, binding included, from whichever source is configured.
    const verdict = await this.readVerdict(root, repo, found.number, branch, request.taskId, sha, self, ctx)
    if (verdict === null || verdict.result.kind !== 'review' || !isApproval(verdict.result.verdict)) {
      throw new Error(`forge_review_gone: pull request ${found.number} is no longer approved with green checks at ${sha}`)
    }
    // A review verdict already waited for green checks; a comment verdict never looked, so look now.
    if (this.options.verdictSource === 'comments' && await this.readChecks(root, repo, found.number, sha, ctx) !== 'passed') {
      throw new Error(`forge_review_gone: pull request ${found.number} is approved, but its checks at ${sha} are not green`)
    }
    const neutral = await mkdtemp(join(tmpdir(), 'devloop-merge-'))
    try {
      await this.forge(neutral, ['pr', 'merge', String(found.number), '--repo', repoSlug(repo), '--merge', '--match-head-commit', sha], ctx)
    } finally {
      await rm(neutral, { recursive: true, force: true })
    }
    const merged = await this.pullRequestOf(root, repo, branch, request.workBranch, sha, ctx)
    if (merged.state !== 'MERGED') throw new Error(`forge_merge: pull request ${found.number} is not merged after merging it`)
    return { number: merged.number, mergeCommit: merged.mergeCommit }
  }

  /**
   * Open the release pull request, the work branch into the trunk, or find the
   * one already open. Every task in it was reviewed and merged on its own, so
   * its body is a summary for the reviewer to check against those, not a diff
   * to review from scratch.
   */
  async openRelease(request: { workspaceRoot: string, workBranch: string, title: string, body: string }): Promise<{ number: number }> {
    const { root, repo, ctx } = this.releaseContext(request.workspaceRoot, request.workBranch)
    const existing = await this.releaseOf(root, repo, request.workBranch, ctx)
    if (existing !== null) return { number: existing.number }
    await this.ensureLabel(root, repo, ctx)
    await this.forge(root, [
      'pr', 'create', '--repo', repoSlug(repo), '--head', request.workBranch, '--base', this.options.base,
      '--label', DEVLOOP_LABEL, '--title', request.title.slice(0, 200), '--body', request.body,
    ], ctx)
    const created = await this.releaseOf(root, repo, request.workBranch, ctx)
    if (created === null) throw new Error('forge_release: the release pull request was created but cannot be found')
    return { number: created.number }
  }

  /**
   * Where the release stands, and merge it once it may be: approved by a
   * reviewer at its head, with green checks. Always read from GitHub reviews,
   * whatever `verdictSource` says for task pull requests: the release body asks
   * for a review, and a comment envelope needs a task id the release has not. One look, no waiting — the loop
   * asks again on its next tick. Merged into the trunk on the forge only; the
   * checkout is never moved onto the trunk.
   */
  async advanceRelease(request: { workspaceRoot: string, workBranch: string, number: number }): Promise<{ state: 'merged', number: number, mergeCommit: string } | { state: 'waiting' | 'changes', number: number, notes?: string }> {
    const { root, repo, ctx } = this.releaseContext(request.workspaceRoot, request.workBranch)
    const self = await this.authenticatedLogin(root, repo, ctx)
    // This goal's own release, by number: a work branch that carries goal after goal has an earlier one merged from the same head.
    const found = await this.releaseOf(root, repo, request.workBranch, ctx, true, request.number)
    if (found === null) throw new Error(`forge_release: no release pull request #${String(request.number)} from ${request.workBranch}`)
    if (found.state === 'MERGED') return { state: 'merged', number: found.number, mergeCommit: found.mergeCommit }
    const verdict = await this.readReviewVerdict(root, repo, found.number, 'release', found.head, self, ctx)
    if (verdict === null) return { state: 'waiting', number: found.number }
    if (verdict.result.kind !== 'review' || verdict.result.verdict !== 'PASS') {
      return { state: 'changes', number: found.number, ...(verdict.result.kind === 'review' && verdict.result.notes ? { notes: verdict.result.notes } : {}) }
    }
    const neutral = await mkdtemp(join(tmpdir(), 'devloop-merge-'))
    try {
      await this.forge(neutral, ['pr', 'merge', String(found.number), '--repo', repoSlug(repo), '--merge', '--match-head-commit', found.head], ctx)
    } finally {
      await rm(neutral, { recursive: true, force: true })
    }
    const merged = await this.releaseOf(root, repo, request.workBranch, ctx, true, request.number)
    if (merged?.state !== 'MERGED') throw new Error(`forge_release: pull request ${found.number} is not merged after merging it`)
    return { state: 'merged', number: merged.number, mergeCommit: merged.mergeCommit }
  }

  private releaseContext(workspaceRoot: string, workBranch: string): { root: string, repo: ForgeRepo, ctx: RunCtx } {
    if (!isValidBranchName(workBranch) || workBranch.toLowerCase() === this.options.base.toLowerCase()) {
      throw new Error('forge_release: the work branch is missing, invalid or the trunk')
    }
    if (this.options.reviewers.length === 0 || this.options.pushUrl.length === 0) throw new Error('forge_release: forge is not configured to decide or merge')
    const ctx: RunCtx = { deadline: Date.now() + MERGE_BUDGET_MS, budgetMs: MERGE_BUDGET_MS, base: this.options.base }
    return { root: resolve(workspaceRoot), repo: parseRemoteUrl(this.options.pushUrl), ctx }
  }

  /** The release pull request: same-repo, the work branch into the trunk; open, or also merged when asked. */
  private async releaseOf(root: string, repo: ForgeRepo, workBranch: string, ctx: RunCtx, orMerged = false, number?: number): Promise<{ number: number, head: string, state: 'OPEN' | 'MERGED', mergeCommit: string } | null> {
    const raw = await this.forge(root, [
      'pr', 'list', '--repo', repoSlug(repo), '--head', workBranch, '--base', this.options.base, '--state', orMerged ? 'all' : 'open',
      '--json', `${PR_FIELDS},state,mergeCommit`, '--limit', '20',
    ], ctx)
    const listed: unknown = parseJson(raw, 'forge_pr: pr list')
    if (!Array.isArray(listed)) throw new Error('forge_pr: pr list did not return an array')
    const matching = listed.filter(entry => isRecord(entry) && (entry.state === 'OPEN' || (orMerged && entry.state === 'MERGED')))
      .map(entry => ({ entry: entry as Record<string, unknown>, pr: readPullRequest(entry) }))
      .filter(({ pr }) => !pr.isCrossRepository && pr.baseRefName === this.options.base && pr.headRefName === workBranch)
      .filter(({ pr }) => number === undefined || pr.number === number)
    const open = matching.filter(({ entry }) => entry.state === 'OPEN')
    if (open.length > 1) throw new Error(`forge_release: ${open.length} open release pull requests from ${workBranch}`)
    const chosen = open[0] ?? matching.find(({ entry }) => entry.state === 'MERGED')
    if (chosen === undefined) return null
    if (chosen.entry.state === 'OPEN') return { number: chosen.pr.number, head: chosen.pr.headRefOid.toLowerCase(), state: 'OPEN', mergeCommit: '' }
    const oid = isRecord(chosen.entry.mergeCommit) ? chosen.entry.mergeCommit.oid : undefined
    if (typeof oid !== 'string' || !SHA.test(oid)) throw new Error(`forge_release: pull request ${chosen.pr.number} is merged but names no merge commit`)
    return { number: chosen.pr.number, head: chosen.pr.headRefOid.toLowerCase(), state: 'MERGED', mergeCommit: oid.toLowerCase() }
  }

  /** The one pull request for this task against the work branch at the reviewed commit: open, or merged at it. */
  private async pullRequestOf(root: string, repo: ForgeRepo, branch: string, base: string, sha: string, ctx: RunCtx): Promise<{ number: number, state: 'OPEN' | 'MERGED', mergeCommit: string, mergedBy: string | null }> {
    const raw = await this.forge(root, [
      'pr', 'list', '--repo', repoSlug(repo), '--head', branch, '--state', 'all',
      '--json', `${PR_FIELDS},state,mergeCommit,mergedBy`, '--limit', '20',
    ], ctx)
    const listed: unknown = parseJson(raw, 'forge_pr: pr list')
    if (!Array.isArray(listed)) throw new Error('forge_pr: pr list did not return an array')
    const matching = listed.filter(entry => isRecord(entry) && (entry.state === 'OPEN' || entry.state === 'MERGED'))
      .filter(entry => matchesReviewTarget(readPullRequest(entry), base, branch, sha))
    if (matching.length === 0) throw new Error(`forge_merge: no open or merged pull request for ${branch} into ${base} at ${sha}; it was closed, retargeted or pushed to after review`)
    if (matching.length > 1) throw new Error(`forge_merge: ${matching.length} pull requests for ${branch} into ${base} at ${sha}`)
    const entry = matching[0] as Record<string, unknown>
    const number = readPullRequest(entry).number
    if (entry.state === 'OPEN') return { number, state: 'OPEN', mergeCommit: '', mergedBy: null }
    const oid = isRecord(entry.mergeCommit) ? entry.mergeCommit.oid : undefined
    if (typeof oid !== 'string' || !SHA.test(oid)) throw new Error(`forge_merge: pull request ${number} is merged but names no merge commit`)
    const login = isRecord(entry.mergedBy) ? entry.mergedBy.login : undefined
    return { number, state: 'MERGED', mergeCommit: oid.toLowerCase(), mergedBy: typeof login === 'string' && LOGIN.test(login) ? login : null }
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    try {
      await this.forge('.', ['--version'], { deadline: Date.now() + FORGE_TIMEOUT_MS, budgetMs: FORGE_TIMEOUT_MS })
      return 'ok'
    } catch {
      return 'down'
    }
  }

  /**
   * Publish the reviewed commit from a throwaway repository that borrows the
   * workspace's objects but none of its configuration.
   *
   * The workspace's own `.git/config` is attacker-reachable in this system —
   * it is the checkout models have been editing — and git will run commands it
   * names during a push through more settings than can be enumerated:
   * `credential.helper`, `core.sshCommand`, `remote.<name>.vcs`, a signer via
   * `push.gpgSign`, nested pushes via `push.recurseSubmodules`, and transport
   * redirection via `http.*` or a remote whose *name* is the literal target URL.
   * Excluding that file entirely is the only defense that does not depend on
   * keeping a list current. Global configuration still applies, so the
   * operator's own credential helper keeps working.
   */
  private async publish(root: string, url: string, branch: string, sha: string, ctx: RunCtx, work: { branch: string, sha: string } | null = null): Promise<void> {
    const objects = await this.objectsDir(root, ctx)
    const scratch = await mkdtemp(join(tmpdir(), 'devloop-forge-'))
    try {
      // An empty template keeps `init.templateDir` from installing hooks here.
      const template = join(scratch, 'template')
      const isolated = join(scratch, 'repo')
      await mkdir(template)
      await this.git(scratch, ['init', '--bare', '--quiet', `--template=${template}`, isolated], ctx)

      const borrow = { ...GIT_ENV, GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternate(objects) }
      const ref = `refs/heads/${branch}`
      await this.git(isolated, ['update-ref', ref, sha], ctx, borrow)
      const staged = (await this.git(isolated, ['rev-parse', ref], ctx, borrow)).trim().toLowerCase()
      if (staged !== sha) throw new Error('forge_publish: isolated ref does not hold the reviewed commit')

      // `ls-remote --get-url` expands `insteadOf` but NOT `pushInsteadOf`, while
      // the push honours both. Ask the question the push will actually ask, via
      // a remote this code names itself so the URL can never be read as a name.
      await this.git(isolated, ['remote', 'add', '--', TARGET_REMOTE, url], ctx, borrow)
      const effective = (await this.git(isolated, ['remote', 'get-url', '--push', '--', TARGET_REMOTE], ctx, borrow)).trim()
      if (effective !== url) {
        throw new Error(`forge_remote: git config rewrites ${maskUrl(url)} to ${maskUrl(effective)}`)
      }

      await this.git(isolated, [
        // Pushed through the same remote that was just checked. Passing the URL
        // positionally would let git resolve it as a remote name again, and an
        // inherited `remote."<url>".url` would then decide the real target.
        // No --atomic: this pushes one ref, so it buys nothing and fails on
        // servers without the capability.
        'push', '--no-verify', '--no-signed', '--recurse-submodules=no',
        '--', TARGET_REMOTE, `${ref}:${ref}`,
      ], ctx, borrow, PUSH_TIMEOUT_MS)
      if (work !== null) await this.publishWorkBranch(isolated, work, ctx, borrow)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /**
   * Make the work branch on the forge the base the task was cut from. Missing,
   * it is created at that commit; behind it, it is fast-forwarded; anything
   * else means someone moved it, and the task is not offered against a base
   * it was never built on.
   */
  private async publishWorkBranch(isolated: string, work: { branch: string, sha: string }, ctx: RunCtx, env: Readonly<Record<string, string>>): Promise<void> {
    const ref = `refs/heads/${work.branch}`
    // ls-remote matches by suffix, so only the line naming exactly this ref is the work branch.
    const line = (await this.git(isolated, ['ls-remote', '--', TARGET_REMOTE, ref], ctx, env)).split('\n').map(row => row.trim().split(/\s+/)).find(fields => fields[1] === ref)
    const remote = line === undefined ? null : (line[0] ?? '').toLowerCase()
    if (remote === work.sha) return
    if (remote !== null) {
      if (!SHA.test(remote)) throw new Error(`forge_work_branch: the forge answered ${work.branch} with something that is not a commit`)
      const ancestor = (a: string, b: string) => this.git(isolated, ['merge-base', '--is-ancestor', a, b], ctx, env).then(() => true, () => false)
      // Ahead of the base: other tasks merged since this one was cut, and that is the normal course of a goal.
      if (await ancestor(work.sha, remote)) return
      if (!await ancestor(remote, work.sha)) throw new Error(`forge_work_branch: ${work.branch} on the forge has moved away from the task's base; bring it back or restart the goal`)
    }
    await this.git(isolated, ['update-ref', ref, work.sha], ctx, env)
    await this.git(isolated, [
      'push', '--no-verify', '--no-signed', '--recurse-submodules=no',
      '--', TARGET_REMOTE, `${ref}:${ref}`,
    ], ctx, env, PUSH_TIMEOUT_MS)
  }

  /** Absolute object store the throwaway repository borrows from. */
  private async objectsDir(root: string, ctx: RunCtx): Promise<string> {
    const raw = (await this.git(root, ['rev-parse', '--git-path', 'objects'], ctx)).trim()
    if (raw.length === 0) throw new Error('forge_publish: cannot locate the workspace object store')
    return isAbsolute(raw) ? raw : join(root, raw)
  }

  private async ensurePullRequest(
    root: string,
    repo: ForgeRepo,
    branch: string,
    sha: string,
    task: PullRequestTask & { readonly taskId: string, readonly title: string },
    ctx: RunCtx,
  ): Promise<number> {
    await this.ensureLabel(root, repo, ctx)
    await this.retargetStray(root, repo, branch, sha, ctx)
    const existing = await this.findPullRequest(root, repo, branch, sha, ctx)
    if (existing !== null) {
      // A reused pull request still carries the previous attempt's instructions.
      // A reviewer following them would attest the old commit, and that verdict
      // is correctly ignored — leaving the loop to wait for one that never comes.
      await this.forge(root, [
        'pr', 'edit', String(existing.number), '--repo', repoSlug(repo),
        '--title', pullRequestTitle(task.taskId, task.title),
        '--body', pullRequestBody(task.taskId, sha, this.options.reviewers, this.options.verdictSource, task),
        '--add-label', DEVLOOP_LABEL,
      ], ctx)
      return existing.number
    }
    await this.forge(root, [
      'pr', 'create',
      '--repo', repoSlug(repo),
      '--head', branch,
      '--base', ctx.base ?? this.options.base,
      '--label', DEVLOOP_LABEL,
      '--title', pullRequestTitle(task.taskId, task.title),
      '--body', pullRequestBody(task.taskId, sha, this.options.reviewers, this.options.verdictSource, task),
    ], ctx)
    const created = await this.findPullRequest(root, repo, branch, sha, ctx)
    if (created === null) throw new Error('forge_pr: pull request was created but cannot be found')
    return created.number
  }

  /**
   * An open pull request from this task's branch against another base — one
   * opened before the work branch was recorded, say — would otherwise sit
   * beside a second one, still pointing at trunk. It is moved to this base, or,
   * when this base already has one (GitHub refuses a second for the same head
   * and base), closed as superseded by it.
   */
  private async retargetStray(root: string, repo: ForgeRepo, branch: string, sha: string, ctx: RunCtx): Promise<void> {
    // Only toward a work branch: without one there is nothing to move a pull request to but trunk.
    const base = ctx.base
    if (base === undefined || !ctx.onWorkBranch) return
    const raw = await this.forge(root, ['pr', 'list', '--repo', repoSlug(repo), '--head', branch, '--state', 'open', '--json', PR_FIELDS, '--limit', '10'], ctx)
    const listed: unknown = parseJson(raw, 'forge_pr: pr list')
    if (!Array.isArray(listed)) throw new Error('forge_pr: pr list did not return an array')
    const ours = listed.map(entry => readPullRequest(entry)).filter(pr => !pr.isCrossRepository && pr.headRefName === branch && pr.headRefOid.toLowerCase() === sha)
    // One already on the work branch is the one to reuse; the first stray moved there becomes it.
    let kept = ours.find(pr => pr.baseRefName === base)?.number
    for (const stray of ours.filter(pr => pr.baseRefName !== base)) {
      if (kept === undefined) {
        await this.forge(root, ['pr', 'edit', String(stray.number), '--repo', repoSlug(repo), '--base', base], ctx)
        kept = stray.number
      } else {
        await this.forge(root, ['pr', 'close', String(stray.number), '--repo', repoSlug(repo), '--comment', `Superseded by #${String(kept)}, which targets \`${base}\`.`], ctx)
      }
    }
  }

  /** The `devloop` label, created or refreshed; `--force` makes this safe to repeat. */
  private async ensureLabel(root: string, repo: ForgeRepo, ctx: RunCtx): Promise<void> {
    await this.forge(root, [
      'label', 'create', DEVLOOP_LABEL, '--repo', repoSlug(repo), '--force',
      '--color', '5319e7', '--description', 'Opened by DevLoop; reviewed by PR-daemon, fixed by DevLoop itself',
    ], ctx)
  }

  private async findPullRequest(
    root: string,
    repo: ForgeRepo,
    branch: string,
    sha: string,
    ctx: RunCtx,
  ): Promise<PullRequest | null> {
    const raw = await this.forge(root, [
      'pr', 'list', '--repo', repoSlug(repo), '--head', branch, '--state', 'open',
      '--json', PR_FIELDS, '--limit', '10',
    ], ctx)
    const listed: unknown = parseJson(raw, 'forge_pr: pr list')
    if (!Array.isArray(listed)) throw new Error('forge_pr: pr list did not return an array')
    const matching = listed.map(entry => readPullRequest(entry)).filter(pr => matchesReviewTarget(pr, ctx.base ?? this.options.base, branch, sha))
    if (matching.length === 0) return null
    // Two open pull requests for one head is ambiguous; refuse rather than guess.
    if (matching.length > 1) throw new Error(`forge_pr: ${matching.length} open pull requests match ${branch}`)
    return matching[0] ?? null
  }

  private async readVerdict(
    root: string,
    repo: ForgeRepo,
    number: number,
    branch: string,
    taskId: string,
    sha: string,
    self: string,
    ctx: RunCtx,
  ): Promise<ForgeVerdict | null> {
    const raw = await this.forge(root, [
      'pr', 'view', String(number), '--repo', repoSlug(repo), '--json', PR_FIELDS,
    ], ctx)
    const view: unknown = parseJson(raw, 'forge_pr: pr view')
    if (!isRecord(view)) throw new Error('forge_pr: pr view did not return an object')
    // Re-established every poll: a pull request retargeted mid-review must not
    // keep deciding the commit it no longer points at.
    const pr = readPullRequest(view)
    if (!matchesReviewTarget(pr, ctx.base ?? this.options.base, branch, sha) || pr.number !== number) {
      // The review was of a pull request that is no longer this one: a question for review, not the forge.
      throw new Error(`forge_review_gone: pull request ${number} no longer targets ${branch} at ${sha}`)
    }

    if (this.options.verdictSource === 'reviews') return this.readReviewVerdict(root, repo, number, taskId, sha, self, ctx)
    const verdicts: ForgeVerdict[] = []
    for (const comment of await this.readComments(root, repo, number, ctx)) {
      const { author, body } = comment
      if (!LOGIN.test(author)) continue
      if (author.toLowerCase() === self.toLowerCase()) continue
      if (!this.options.reviewers.some(allowed => allowed.toLowerCase() === author.toLowerCase())) continue
      let parsed
      try {
        parsed = parseDevloopResult(body)
      } catch {
        continue
      }
      if (parsed.kind !== 'review') continue
      if (parsed.taskId !== taskId) continue
      if (parsed.reviewedSha.toLowerCase() !== sha) continue
      verdicts.push({ result: parsed, author })
    }
    if (verdicts.length === 0) return null
    // Any dissent about this commit outranks an approval, whoever spoke last.
    const dissent = verdicts.filter(entry => !isApproval(entry.result.verdict))
    if (dissent.length > 0) return dissent[dissent.length - 1] ?? null
    return verdicts[verdicts.length - 1] ?? null
  }

  /**
   * The verdict GitHub's own reviews give this commit.
   *
   * Only an allowlisted reviewer who is not this host counts, and only a review
   * whose `commit_id` is the commit under review: an approval of an earlier push
   * says nothing about this one. Each reviewer's latest APPROVED,
   * CHANGES_REQUESTED or DISMISSED at this commit is their word — a dismissed
   * review withdraws it rather than bringing back the one before (COMMENTED and
   * PENDING say nothing) — and any reviewer whose word is changes outranks
   * every approval, with every such reviewer's body kept as the notes.
   */
  private async readReviewVerdict(
    root: string,
    repo: ForgeRepo,
    number: number,
    taskId: string,
    sha: string,
    self: string,
    ctx: RunCtx,
  ): Promise<ForgeVerdict | null> {
    const raw = await this.forge(root, [
      'api', '--hostname', repo.host, '--paginate',
      '--jq', '.[] | {author: .user.login, state: .state, commit: .commit_id, body: .body}',
      `repos/${repo.owner}/${repo.name}/pulls/${number}/reviews`,
    ], ctx)
    const rows = lines(raw)
    if (rows.length > MAX_REVIEW_COMMENTS) {
      throw new Error(`forge_pr: pull request ${number} has more than ${MAX_REVIEW_COMMENTS} reviews`)
    }
    const latest = new Map<string, { author: string, state: 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED', body: string }>()
    rows.forEach((row, index) => {
      const parsed: unknown = parseJson(row, `forge_pr: review ${index}`)
      if (!isRecord(parsed)) throw new Error(`forge_pr: review ${index} is not an object`)
      const { author, state, commit, body } = parsed
      if (typeof author !== 'string' || typeof state !== 'string' || typeof commit !== 'string') {
        throw new Error(`forge_pr: review ${index} is missing an author, state or commit`)
      }
      if (!LOGIN.test(author) || author.toLowerCase() === self.toLowerCase()) return
      if (!this.options.reviewers.some(allowed => allowed.toLowerCase() === author.toLowerCase())) return
      if (commit.toLowerCase() !== sha) return
      if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') return
      // GitHub lists reviews oldest first, so a later word replaces an earlier one.
      latest.set(author.toLowerCase(), { author, state, body: typeof body === 'string' ? body : '' })
    })
    const words = [...latest.values()]
    const changes = words.filter(word => word.state === 'CHANGES_REQUESTED')
    const said = changes[0] ?? words.find(word => word.state === 'APPROVED')
    if (said === undefined) return null
    // An approval is a pass only once this commit's checks have passed too: a red build is rework, a running one is a wait.
    if (said.state === 'APPROVED') {
      const checks = await this.readChecks(root, repo, number, sha, ctx)
      if (checks === 'pending') return null
      if (checks !== 'passed') {
        return { author: said.author, result: { version: 1, kind: 'review', taskId, reviewedSha: sha, verdict: 'REWORK', notes: `Approved, but these checks failed: ${checks.join(', ')}`.slice(0, MAX_NOTES) } }
      }
    }
    const notes = truncated(said.state === 'CHANGES_REQUESTED'
      ? changes.map(word => changes.length > 1 ? `${word.author}: ${word.body.trim()}` : word.body.trim()).filter(Boolean).join('\n\n')
      : said.body.trim())
    return {
      author: said.author,
      result: {
        version: 1,
        kind: 'review',
        taskId,
        reviewedSha: sha,
        verdict: said.state === 'APPROVED' ? 'PASS' : 'REWORK',
        ...(notes === '' ? {} : { notes }),
      },
    }
  }

  /**
   * The pull request's checks at the reviewed commit: passed (none failing and
   * none running — a repository with no checks has passed unless
   * `requireChecks`), still running, or the names of those that failed. The
   * head is read in the same call as the rollup, so a push between the binding
   * check and this one cannot lend the reviewed commit a newer commit's checks.
   */
  private async readChecks(root: string, repo: ForgeRepo, number: number, sha: string, ctx: RunCtx): Promise<'passed' | 'pending' | string[]> {
    const raw = await this.forge(root, ['pr', 'view', String(number), '--repo', repoSlug(repo), '--json', 'headRefOid,statusCheckRollup'], ctx)
    const view: unknown = parseJson(raw, 'forge_pr: pr checks')
    const head = isRecord(view) && typeof view.headRefOid === 'string' ? view.headRefOid.toLowerCase() : ''
    if (head !== sha) throw new Error(`forge_review_gone: pull request ${number} is at ${head || 'an unknown head'}, not the reviewed ${sha}; its checks are not this commit's`)
    const rollup = isRecord(view) ? view.statusCheckRollup : undefined
    if (!Array.isArray(rollup)) throw new Error('forge_pr: pr checks did not return a list')
    if (rollup.length === 0 && this.options.requireChecks) return 'pending'
    const failed: string[] = []
    let running = false
    for (const check of rollup) {
      if (!isRecord(check)) throw new Error('forge_pr: a check is not an object')
      // A check run reports status and conclusion; a commit status reports state.
      const outcome = String(check.conclusion ?? check.state ?? '').toUpperCase()
      const name = String(check.name ?? check.context ?? 'a check').slice(0, 100)
      if (outcome === 'SUCCESS' || outcome === 'NEUTRAL' || outcome === 'SKIPPED') continue
      if (outcome === '' || outcome === 'PENDING' || outcome === 'EXPECTED' || outcome === 'QUEUED' || outcome === 'IN_PROGRESS') running = true
      else failed.push(name)
    }
    if (failed.length > 0) return failed
    return running ? 'pending' : 'passed'
  }

  /**
   * Read the whole comment thread, paginated. `gh pr view` returns one page, and
   * a truncated thread is indistinguishable from a thread with no objection in
   * it, so the full set is fetched and an oversized thread is refused.
   */
  private async readComments(
    root: string,
    repo: ForgeRepo,
    number: number,
    ctx: RunCtx,
  ): Promise<readonly { author: string; body: string }[]> {
    const raw = await this.forge(root, [
      'api', '--hostname', repo.host, '--paginate',
      '--jq', '.[] | {author: .user.login, body: .body}',
      `repos/${repo.owner}/${repo.name}/issues/${number}/comments`,
    ], ctx)
    const rows = lines(raw)
    if (rows.length > MAX_REVIEW_COMMENTS) {
      throw new Error(`forge_pr: pull request ${number} has more than ${MAX_REVIEW_COMMENTS} comments`)
    }
    return rows.map((row, index) => {
      const parsed: unknown = parseJson(row, `forge_pr: comment ${index}`)
      if (!isRecord(parsed)) throw new Error(`forge_pr: comment ${index} is not an object`)
      const { author, body } = parsed
      if (typeof author !== 'string' || typeof body !== 'string') {
        throw new Error(`forge_pr: comment ${index} is missing an author or body`)
      }
      return { author, body }
    })
  }

  /**
   * Fail closed: without a known host identity, self-review cannot be excluded.
   *
   * This asks who the host authenticates as, which is the account that opens the
   * pull request. Under a GitHub App installation token that need not be the
   * login a bot comments under, so the exclusion below rests on them matching.
   * The residual gap needs both a mismatch and that bot being on `reviewers`.
   */
  private async authenticatedLogin(root: string, repo: ForgeRepo, ctx: RunCtx): Promise<string> {
    let raw: string
    try {
      raw = await this.forge(root, ['api', '--hostname', repo.host, 'user', '--jq', '.login'], ctx)
    } catch (error) {
      throw new Error(`forge_identity: cannot read the authenticated account (${describe(error)})`)
    }
    const login = raw.trim()
    if (!LOGIN.test(login)) throw new Error('forge_identity: authenticated account is not a valid login')
    return login
  }

  private async git(
    root: string,
    argv: readonly string[],
    ctx: RunCtx,
    env: Readonly<Record<string, string>> = GIT_ENV,
    cap = GIT_TIMEOUT_MS,
  ): Promise<string> {
    const { stdout } = await this.runner({
      command: 'git',
      argv: ['-C', root, '-c', `core.hooksPath=${GIT_HOOKS_PATH}`, '-c', 'core.fsmonitor=false', ...argv],
      cwd: root,
      timeoutMs: remainingMs(ctx, cap),
      env,
      unsetEnv: scrubbedEnvNames(),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    return stdout
  }

  private async forge(root: string, argv: readonly string[], ctx: RunCtx): Promise<string> {
    const { stdout } = await this.runner({
      command: this.options.command,
      argv,
      cwd: root,
      timeoutMs: remainingMs(ctx, FORGE_TIMEOUT_MS),
      // GH_REPO / GH_HOST would otherwise override the target this backend derives itself.
      env: { GH_REPO: '', GH_HOST: '', GH_PROMPT_DISABLED: '1', CLICOLOR: '0' },
      unsetEnv: scrubbedEnvNames(),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    return stdout
  }
}

export function pullRequestTitle(taskId: string, title: string): string {
  return `DevLoop ${taskId}: ${title}`
}

/** What the task asked for, as the reviewer should judge it: the contract, not the worker's account of it. */
export interface PullRequestTask {
  readonly acceptance: readonly string[]
  readonly allowedPaths: readonly string[]
}

/** The contract in the body. Planner-written text: one line each, bounded, and no @mention that would ping anyone. */
function taskSection(task: PullRequestTask | undefined): string[] {
  if (task === undefined) return []
  const line = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/@/g, '@\u200b').slice(0, 300)
  return [
    '**Acceptance:**',
    ...task.acceptance.slice(0, 20).map(item => `- ${line(item)}`),
    '',
    `**Allowed paths:** ${task.allowedPaths.slice(0, 20).map(path => `\`${line(path).replace(/`/g, '')}\``).join(', ')}`,
    '',
  ]
}

export function pullRequestBody(taskId: string, sha: string, reviewers: readonly string[], source: ForgeOptions['verdictSource'] = 'reviews', task?: PullRequestTask): string {
  const who = reviewers.map(login => `\`${login}\``).join(', ')
  if (source === 'reviews') {
    return [
      `DevLoop task \`${taskId}\` is ready for review at commit \`${sha}\`.`,
      '',
      ...taskSection(task),
      'Decide with a GitHub review on this pull request: **Approve**, or **Request changes**',
      'with what to change in the review body, which is given to the worker for its next attempt.',
      '',
      `Only reviews from ${who} of exactly this commit are read, never one from the account`,
      'that opened this pull request. Comments are not read. If any of them requests changes,',
      'that outranks every approval.',
      '',
      `Opened by DevLoop (label \`${DEVLOOP_LABEL}\`): DevLoop reworks it itself, so it is not for \`$pr-fix\`,`,
      'and DevLoop merges it once approved: do not press Merge here.',
    ].join('\n')
  }
  return [
    `DevLoop task \`${taskId}\` is ready for review at commit \`${sha}\`.`,
    '',
    ...taskSection(task),
    'Reply on this pull request with a comment containing exactly one envelope:',
    '',
    resultInstructions('review', taskId, sha),
    '',
    `Only comments from ${who} are read,`,
    'and never one from the account that opened this pull request.',
    'Any non-approving verdict for this commit outranks an approval.',
  ].join('\n')
}

/** Notes within the cap, saying so when they were cut. */
function truncated(text: string): string {
  const marker = '\n[truncated]'
  return text.length <= MAX_NOTES ? text : `${text.slice(0, MAX_NOTES - marker.length)}${marker}`
}

function isApproval(verdict: ReviewResult['verdict']): boolean {
  return verdict === 'PASS' || verdict === 'PASS_WITH_NOTES'
}

function matchesReviewTarget(pr: PullRequest, base: string, branch: string, sha: string): boolean {
  return !pr.isCrossRepository
    && pr.baseRefName === base
    && pr.headRefName === branch
    && pr.headRefOid.toLowerCase() === sha
}

function readPullRequest(value: unknown): PullRequest {
  if (!isRecord(value)) throw new Error('forge_pr: pull request entry is not an object')
  const number = value.number
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error('forge_pr: pull request number is invalid')
  }
  const baseRefName = value.baseRefName
  const headRefName = value.headRefName
  const headRefOid = value.headRefOid
  const isCrossRepository = value.isCrossRepository
  if (typeof baseRefName !== 'string' || typeof headRefName !== 'string') {
    throw new Error('forge_pr: pull request refs are missing')
  }
  if (typeof headRefOid !== 'string' || !SHA.test(headRefOid)) {
    throw new Error('forge_pr: pull request head OID is missing or malformed')
  }
  if (typeof isCrossRepository !== 'boolean') {
    throw new Error('forge_pr: pull request cross-repository flag is missing')
  }
  return { number, baseRefName, headRefName, headRefOid, isCrossRepository }
}

/** Abortable delay; the host's dispatch timeout must be able to cut a long wait short. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('backend timeout'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('backend timeout'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

/**
 * How long a child may run: never past this dispatch's deadline, so setup calls
 * cannot push the run beyond the budget the loop granted it.
 */
function remainingMs(ctx: RunCtx, cap: number): number {
  const left = ctx.deadline - Date.now()
  if (left <= 0) {
    throw new Error(`forge_timeout: review exceeded ${minutes(ctx.budgetMs)} minutes`)
  }
  // A child that hits its timeout is still reaped (SIGTERM, then SIGKILL), and
  // that grace runs after the timer. Hold it back from the child's own budget so
  // the wall clock stays close to the deadline; on a budget too small to spare
  // the full window, reserve what it can.
  const reserve = Math.min(RUNNER_REAP_MS, Math.floor(left / 2))
  return Math.max(1, Math.min(cap, left - reserve))
}

/**
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` is a `:`-separated list (`;` on Windows).
 * A path containing the separator, a quote, or a backslash must use git's
 * C-style quoting or it is silently split into two alternates.
 */
export function quoteAlternate(path: string): string {
  const separator = process.platform === 'win32' ? ';' : ':'
  if (!path.includes(separator) && !path.includes('"') && !path.includes('\\')) return path
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000)
}

function lines(raw: string): string[] {
  return raw.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
