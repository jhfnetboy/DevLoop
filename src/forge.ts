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
const DEFAULT_POLL_INTERVAL_MS = 30_000
/** Node clamps a longer delay to 1ms, so a larger wait would silently busy-poll. */
const MAX_TIMER_MS = 2_147_483_647
/** Named by this code, so a hostile URL can never be mistaken for a remote name. */
const TARGET_REMOTE = 'devloop-target'
/**
 * A hard ceiling on the thread, not a window: discarding older comments would
 * let a flood of filler bury an objection behind a newer approval, so a thread
 * past this size fails closed instead.
 */
export const MAX_REVIEW_COMMENTS = 2_000
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
 * Git runs repository-controlled hooks with this host's privileges, so every
 * invocation here disables them and refuses to prompt, matching the hardening
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
}

export const DEFAULT_FORGE_OPTIONS: ForgeOptions = {
  pushUrl: '',
  base: 'main',
  command: 'gh',
  reviewers: [],
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxWaitMs: 0,
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
    const ctx: RunCtx = { deadline, budgetMs, ...(input.signal === undefined ? {} : { signal: input.signal }) }
    try {
      // Trusted configuration, not the checkout, decides where this goes.
      const url = this.options.pushUrl
      const repo = parseRemoteUrl(url)
      // Identity is read once per dispatch and scoped to this repository's host,
      // never cached across runs where the logged-in account may have changed.
      const self = await this.authenticatedLogin(workspaceRoot, repo, ctx)
      await this.publish(workspaceRoot, url, branch, reviewed, ctx)
      const number = await this.ensurePullRequest(workspaceRoot, repo, branch, reviewed, contract.title, contract.taskId, ctx)

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
  private async publish(root: string, url: string, branch: string, sha: string, ctx: RunCtx): Promise<void> {
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
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
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
    title: string,
    taskId: string,
    ctx: RunCtx,
  ): Promise<number> {
    const existing = await this.findPullRequest(root, repo, branch, sha, ctx)
    if (existing !== null) {
      // A reused pull request still carries the previous attempt's instructions.
      // A reviewer following them would attest the old commit, and that verdict
      // is correctly ignored — leaving the loop to wait for one that never comes.
      await this.forge(root, [
        'pr', 'edit', String(existing.number), '--repo', repoSlug(repo),
        '--title', pullRequestTitle(taskId, title),
        '--body', pullRequestBody(taskId, sha, this.options.reviewers),
      ], ctx)
      return existing.number
    }
    await this.forge(root, [
      'pr', 'create',
      '--repo', repoSlug(repo),
      '--head', branch,
      '--base', this.options.base,
      '--title', pullRequestTitle(taskId, title),
      '--body', pullRequestBody(taskId, sha, this.options.reviewers),
    ], ctx)
    const created = await this.findPullRequest(root, repo, branch, sha, ctx)
    if (created === null) throw new Error('forge_pr: pull request was created but cannot be found')
    return created.number
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
    const matching = listed.map(entry => readPullRequest(entry)).filter(pr => matchesReviewTarget(pr, this.options.base, branch, sha))
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
    if (!matchesReviewTarget(pr, this.options.base, branch, sha) || pr.number !== number) {
      throw new Error(`forge_pr: pull request ${number} no longer targets ${branch} at ${sha}`)
    }

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
      argv: ['-C', root, '-c', `core.hooksPath=${GIT_HOOKS_PATH}`, ...argv],
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

export function pullRequestBody(taskId: string, sha: string, reviewers: readonly string[]): string {
  return [
    `DevLoop task \`${taskId}\` is ready for review at commit \`${sha}\`.`,
    '',
    'Reply on this pull request with a comment containing exactly one envelope:',
    '',
    resultInstructions('review', taskId, sha),
    '',
    `Only comments from ${reviewers.map(login => `\`${login}\``).join(', ')} are read,`,
    'and never one from the account that opened this pull request.',
    'Any non-approving verdict for this commit outranks an approval.',
  ].join('\n')
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
