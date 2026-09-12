import { execFile } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative as relativePath } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordingBackend, RoutedBackend, runInputFor, type AgentBackend, type AgentRunInput } from '../src/backend.ts'
import { resolveConfig } from '../src/config.ts'
import {
  assertForgeOptions,
  ForgePrBackend,
  MAX_REVIEW_COMMENTS,
  parseRemoteUrl,
  pullRequestBody,
  isValidBranchName,
  maskUrl,
  quoteAlternate,
  repoSlug,
  scrubbedEnvNames,
  type ForgeOptions,
} from '../src/forge.ts'
import { contractForTask } from '../src/router.ts'
import { defaultRunner, type HeadlessRun, type HeadlessRunner } from '../src/spawn.ts'
import { baseState, initGitRepo, makeTask, mkdtempInRepo, withTasks } from './helpers.ts'

const execFileAsync = promisify(execFile)

const BASE_SHA = 'b1b2c3d4e5f6b1b2c3d4e5f6b1b2c3d4e5f6b1b2'
const HEAD_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const OTHER_SHA = 'c1b2c3d4e5f6c1b2c3d4e5f6c1b2c3d4e5f6c1b2'
const SELF = 'devloop-bot'
const REVIEWER = 'a-reviewer'
const BRANCH = 'devloop/TASK-1'

/** Tests must never sit on the real 30s poll gap. */
const PUSH_URL = 'git@github.com:acme/widgets.git'
// The comment path's tests predate native reviews; the review path has its own block below.
const FAST: Partial<ForgeOptions> = { pollIntervalMs: 1, maxWaitMs: 400, reviewers: [REVIEWER], pushUrl: PUSH_URL, verdictSource: 'comments' }

function options(overrides: Partial<ForgeOptions> = {}): ForgeOptions {
  return {
    pushUrl: PUSH_URL,
    base: 'main',
    command: 'gh',
    reviewers: [REVIEWER],
    pollIntervalMs: 30_000,
    maxWaitMs: 0,
    verdictSource: 'comments',
    ...overrides,
  }
}

/** `null` means "no implementation SHA at all"; a default parameter would swallow undefined. */
function reviewInput(implementationSha: string | null = HEAD_SHA, taskId = 'TASK-1'): AgentRunInput {
  return {
    action: { type: 'review', taskId },
    contract: contractForTask(
      taskId, 'a title', 'T1', ['src/**'], ['tests pass'], 45, 3, BASE_SHA,
      implementationSha === null ? undefined : implementationSha,
    ),
    workspaceRoot: '/repo',
    worktreeRoot: null,
  }
}

function envelope(taskId: string, sha: string, verdict = 'PASS', notes?: string): string {
  const payload = { version: 1, kind: 'review', taskId, reviewedSha: sha, verdict, ...(notes ? { notes } : {}) }
  return `Looks good to me.\n<devloop_result>${JSON.stringify(payload)}</devloop_result>\n`
}

function comment(author: string, body: string): unknown {
  return { author, body }
}

function pr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    baseRefName: 'main',
    headRefName: BRANCH,
    headRefOid: HEAD_SHA,
    isCrossRepository: false,
    ...overrides,
  }
}

interface Recorded {
  readonly command: string
  readonly argv: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly unsetEnv?: readonly string[]
}

interface StubOptions {
  comments?: unknown[]
  reviews?: unknown[]
  prList?: unknown
  prView?: unknown
  rewrittenUrl?: string
  objectsDir?: string
  stagedSha?: string
  rawComments?: string
  login?: string
  fail?: (call: Recorded) => string | undefined
  calls?: Recorded[]
  onView?: (count: number) => unknown[] | undefined
}

/** The git side of the call sequence, shared by the hand-written runners below. */
function gitStub(joined: string, url = PUSH_URL, tip = HEAD_SHA): { stdout: string; stderr: string } {
  if (joined.includes('--git-path objects')) return { stdout: '/repo/.git/objects\n', stderr: '' }
  if (joined.includes('remote get-url')) return { stdout: `${url}\n`, stderr: '' }
  if (joined.includes('rev-parse')) return { stdout: `${tip}\n`, stderr: '' }
  return { stdout: '', stderr: '' }
}

/** One comment as the paginated `gh api ... --jq` projection emits it: one JSON object per line. */
function commentLines(comments: readonly unknown[]): string {
  return comments.map(entry => JSON.stringify(entry)).join('\n')
}

/** Answers the fixed call sequence run() makes. */
function stubRunner(stub: StubOptions): HeadlessRunner {
  let views = 0
  let added = ''
  return async (request: HeadlessRun) => {
    const call: Recorded = {
      command: request.command,
      argv: request.argv,
      ...(request.env ? { env: request.env } : {}),
      ...(request.unsetEnv ? { unsetEnv: request.unsetEnv } : {}),
    }
    stub.calls?.push(call)
    const failure = stub.fail?.(call)
    if (failure) throw new Error(failure)
    const joined = request.argv.join(' ')
    if (request.command === 'git') {
      if (joined.includes('--git-path objects')) return { stdout: `${stub.objectsDir ?? '/repo/.git/objects'}\n`, stderr: '' }
      if (joined.includes('remote add')) {
        added = request.argv[request.argv.length - 1] ?? ''
        return { stdout: '', stderr: '' }
      }
      if (joined.includes('remote get-url')) {
        // Real git echoes the URL back unless a rewrite rule applies.
        return { stdout: `${stub.rewrittenUrl ?? added}\n`, stderr: '' }
      }
      if (joined.includes('rev-parse')) return { stdout: `${stub.stagedSha ?? HEAD_SHA}\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    if (joined.includes('/reviews')) return { stdout: commentLines(stub.reviews ?? []), stderr: '' }
    if (joined.includes('/comments')) {
      views += 1
      const rolling = stub.onView?.(views)
      const raw = stub.rawComments
      if (raw !== undefined) return { stdout: raw, stderr: '' }
      return { stdout: commentLines(rolling ?? stub.comments ?? []), stderr: '' }
    }
    if (joined.startsWith('api')) return { stdout: `${stub.login ?? SELF}\n`, stderr: '' }
    if (joined.startsWith('pr list')) {
      const listed = stub.prList ?? [pr()]
      // A raw string models gh printing something that is not JSON at all.
      return { stdout: typeof listed === 'string' ? listed : JSON.stringify(listed), stderr: '' }
    }
    if (joined.startsWith('pr view')) {
      const body = stub.prView ?? pr()
      return { stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '' }
    }
    if (joined.startsWith('pr create')) return { stdout: 'https://github.com/acme/widgets/pull/7\n', stderr: '' }
    if (joined.startsWith('pr edit')) return { stdout: '', stderr: '' }
    return { stdout: '', stderr: '' }
  }
}

function backend(overrides: Partial<ForgeOptions> = {}, stub: StubOptions = {}): ForgePrBackend {
  return new ForgePrBackend({ ...FAST, ...overrides }, stubRunner(stub))
}

describe('assertForgeOptions', () => {
  it('refuses values that would smuggle flags into git or gh argv', () => {
    expect(() => assertForgeOptions(options({ pushUrl: '--upload-pack=x' }))).toThrow(/must not start/)
    expect(() => assertForgeOptions(options({ base: '-x' }))).toThrow(/must not start/)
    expect(() => assertForgeOptions(options({ command: '-rf' }))).toThrow(/must not start/)
  })

  it('validates the configured push URL up front', () => {
    expect(() => assertForgeOptions(options({ pushUrl: '/srv/local/repo.git' }))).toThrow(/unsupported remote URL/)
    expect(() => assertForgeOptions(options({ pushUrl: 'https://github.com/acme' }))).toThrow(/owner\/name/)
    // Empty is allowed here so an unused forge route needs no configuration.
    expect(() => assertForgeOptions(options({ pushUrl: '' }))).not.toThrow()
  })

  it('refuses malformed branch names and reviewer logins', () => {
    expect(() => assertForgeOptions(options({ base: 'a b' }))).toThrow(/valid branch/)
    expect(() => assertForgeOptions(options({ reviewers: ['not a login!'] }))).toThrow(/invalid login/)
    expect(() => assertForgeOptions(options({ reviewers: 'nope' as unknown as string[] }))).toThrow(/must be a list/)
  })

  it('keeps timer values inside the range Node can actually wait for', () => {
    expect(() => assertForgeOptions(options({ pollIntervalMs: 0 }))).toThrow(/must be positive/)
    expect(() => assertForgeOptions(options({ pollIntervalMs: -1 }))).toThrow(/between 0 and/)
    expect(() => assertForgeOptions(options({ pollIntervalMs: 1.5 }))).toThrow(/between 0 and/)
    expect(() => assertForgeOptions(options({ maxWaitMs: Number.POSITIVE_INFINITY }))).toThrow(/between 0 and/)
    expect(() => assertForgeOptions(options({ maxWaitMs: 2_147_483_648 }))).toThrow(/between 0 and/)
  })

  it('accepts an absolute path to the forge CLI', () => {
    expect(() => assertForgeOptions(options({ command: '/usr/local/bin/gh' }))).not.toThrow()
  })
})

describe('parseRemoteUrl', () => {
  it('reads owner and name from every form git writes', () => {
    expect(parseRemoteUrl('git@github.com:acme/widgets.git')).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets' })
    expect(parseRemoteUrl('https://github.com/acme/widgets.git')).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets' })
    expect(parseRemoteUrl('ssh://git@ghe.corp.example/acme/widgets')).toEqual({ host: 'ghe.corp.example', owner: 'acme', name: 'widgets' })
    // The host must survive into `gh --repo`, or an enterprise push is inspected on github.com.
    expect(repoSlug(parseRemoteUrl('https://github.com/acme/widgets'))).toBe('github.com/acme/widgets')
    expect(repoSlug(parseRemoteUrl('ssh://git@ghe.corp.example/acme/widgets'))).toBe('ghe.corp.example/acme/widgets')
  })

  it('refuses remotes it cannot pin to one repository', () => {
    expect(() => parseRemoteUrl('')).toThrow(/no push URL/)
    expect(() => parseRemoteUrl('/srv/local/repo.git')).toThrow(/unsupported remote URL/)
    expect(() => parseRemoteUrl('https://github.com/acme')).toThrow(/owner\/name/)
    expect(() => parseRemoteUrl('file:///tmp/x/y')).toThrow(/unsupported remote protocol/)
  })

  it('never lets a credential in the URL reach an error message', () => {
    // Reported by an external review of the merged branch, reproduced first:
    // the token appeared verbatim in the thrown message, which the service logs.
    const secret = 'ghp_SECRETTOKEN123'
    for (const url of [
      `https://user:${secret}@github.com/owner/repo/extra`,
      `https://user:${secret}@github.com/owner/repo.git`,
      `https://${secret}@github.com/owner`,
      // No scheme: the secret still reaches config, argv and logs, which is
      // reason enough — git actually dials a host named `user` here.
      `user:${secret}@github.com:owner/repo.git`,
    ]) {
      let message = ''
      try {
        parseRemoteUrl(url)
        message = 'ACCEPTED'
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).not.toContain(secret)
      // Silently accepting it would put the token in argv and in config too.
      expect(message).toMatch(/must not embed credentials/)
    }
  })

  it('masks only the userinfo, leaving the URL readable', () => {
    expect(maskUrl('https://user:tok@github.com/a/b.git')).toBe('https://***@github.com/a/b.git')
    expect(maskUrl('user:tok@github.com:a/b.git')).toBe('***@github.com:a/b.git')
    expect(maskUrl('https://github.com/a/b.git')).toBe('https://github.com/a/b.git')
    // An scp remote without a secret must survive untouched.
    expect(maskUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
  })

  it('still accepts the ordinary scp remote', () => {
    // The control for the case above: a rule wide enough to reject every scp
    // form would make that test pass while breaking the normal way to configure
    // this backend.
    expect(parseRemoteUrl('git@github.com:owner/repo.git')).toEqual({
      host: 'github.com', owner: 'owner', name: 'repo',
    })
    expect(parseRemoteUrl('github.com:owner/repo')).toEqual({
      host: 'github.com', owner: 'owner', name: 'repo',
    })
  })

  it('refuses a URL whose path is not exactly owner/repo', () => {
    // gh --repo can only name HOST/OWNER/REPO, so anything else would let the
    // push and the API calls disagree about which repository they mean.
    expect(() => parseRemoteUrl('https://github.com/extra/acme/widgets.git')).toThrow(/owner\/name/)
    expect(() => parseRemoteUrl('https://github.com/acme/widgets.git/')).toThrow(/owner\/name/)
    expect(() => parseRemoteUrl('https://github.com/acme/widgets/')).toThrow(/owner\/name/)
  })

  it('accepts branch names git accepts and refuses the rest', () => {
    for (const good of ['main', 'release/2.0', 'a-b_c.d']) {
      expect(isValidBranchName(good)).toBe(true)
    }
    for (const bad of ['foo..bar', 'foo.lock', 'a//b', 'a.', 'a/', 'a/.hidden', 'a@{1}', '.a']) {
      expect(isValidBranchName(bad)).toBe(false)
    }
    expect(() => assertForgeOptions(options({ base: 'foo..bar' }))).toThrow(/valid branch/)
  })
})

describe('ForgePrBackend input guards', () => {
  it('serves review only', async () => {
    const planned: AgentRunInput = { action: { type: 'plan' }, contract: null, workspaceRoot: '/repo', worktreeRoot: null }
    await expect(backend().run(planned)).resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_role/) })
    await expect(backend().run({ ...reviewInput(), action: { type: 'delegate', taskId: 'TASK-1' } }))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_role/) })
  })

  it('refuses a review with no contract, an unsafe id, or no implementation SHA', async () => {
    await expect(backend().run({ ...reviewInput(), contract: null }))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/task contract/) })
    await expect(backend().run(reviewInput(null)))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/implementation SHA/) })
    await expect(backend().run(reviewInput('not-a-sha')))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/implementation SHA/) })
    for (const unsafe of ['../escape', 'has space', '.hidden.lock']) {
      await expect(backend().run(reviewInput(HEAD_SHA, unsafe)))
        .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/unsafe task id/) })
    }
  })

  it('cannot review at all without an authorized reviewer configured', async () => {
    const calls: Recorded[] = []
    const noReviewers = new ForgePrBackend({ ...FAST, reviewers: [] }, stubRunner({ calls }))
    await expect(noReviewers.run(reviewInput())).resolves.toMatchObject({
      status: 'failed',
      detail: expect.stringMatching(/reviewers must list at least one authorized login/),
    })
    // Fails before touching the repository at all.
    expect(calls).toHaveLength(0)
  })
})

describe('ForgePrBackend publishing', () => {
  it('disables repository hooks, prompts and config-named binaries on every git call', async () => {
    const calls: Recorded[] = []
    await backend({}, { calls }).run(reviewInput())
    const gitCalls = calls.filter(call => call.command === 'git')
    expect(gitCalls.length).toBeGreaterThan(0)
    const hooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null'
    for (const call of gitCalls) {
      // cwd is the workspace for reads and the throwaway repo for the push.
      expect(call.argv[0]).toBe('-C')
      expect(call.argv.slice(2, 4)).toEqual(['-c', `core.hooksPath=${hooksPath}`])
      expect(call.env).toMatchObject({
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_SSH_COMMAND: 'ssh',
        GIT_ASKPASS: '',
      })
      // Only the borrowed object store may be added on top of that hardening.
      expect(Object.keys(call.env ?? {}).filter(key => !key.startsWith('GIT_')))
        .toEqual([])
    }
  })

  it('pushes from a throwaway repository so checkout config cannot run commands', async () => {
    const calls: Recorded[] = []
    await backend({}, { calls }).run(reviewInput())
    const push = calls.find(call => call.argv.includes('push'))
    const cwd = push?.argv[1] ?? ''
    // Not the workspace: the push runs in an isolated repo git init created.
    expect(cwd).not.toBe('/repo')
    expect(cwd).toContain('devloop-forge-')
    const init = calls.find(call => call.argv.includes('init'))
    expect(init?.argv).toContain('--bare')
    // An empty template keeps init.templateDir from installing hooks there.
    expect(init?.argv.some(arg => arg.startsWith('--template='))).toBe(true)
    // The commit is staged by SHA through borrowed objects, never re-fetched.
    const update = calls.find(call => call.argv.includes('update-ref'))
    expect(update?.argv.slice(-2)).toEqual([`refs/heads/${BRANCH}`, HEAD_SHA])
    expect(update?.env?.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeTruthy()
  })

  it('never asks the workspace where to push', async () => {
    const calls: Recorded[] = []
    await backend({}, { calls }).run(reviewInput())
    // `git remote get-url` applies the checkout's own url.*.pushInsteadOf, so the
    // target must come from configuration; the only `remote` commands allowed are
    // the ones this code runs inside its own throwaway repository.
    const inWorkspace = calls.filter(call => call.command === 'git' && call.argv[1] === '/repo')
    expect(inWorkspace.some(call => call.argv.includes('remote'))).toBe(false)
    const added = calls.find(call => call.argv.includes('remote') && call.argv.includes('add'))
    expect(added?.argv).toContain(PUSH_URL)
  })

  it('refuses a target that global git config rewrites to somewhere else', async () => {
    const calls: Recorded[] = []
    const result = await backend({}, {
      calls,
      rewrittenUrl: 'https://evil.example/acme/widgets.git',
    }).run(reviewInput())
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringMatching(/rewrites .* to .*evil/) })
    expect(calls.some(call => call.argv.includes('push'))).toBe(false)
  })

  it('drops every inherited variable the allowlist does not name', async () => {
    const calls: Recorded[] = []
    await backend({}, { calls }).run(reviewInput())
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      for (const name of [
        'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_DIR', 'GIT_EXEC_PATH',
        'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'SSH_ASKPASS', 'GH_FORCE_TTY',
        'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD',
      ]) {
        // Present in the list whether or not this machine happens to set it.
        expect(scrubbedEnvNames({ [name]: 'x' })).toContain(name)
      }
      expect(call.unsetEnv).toBeDefined()
    }
  })

  it('keeps only what the child needs to reach the forge as this operator', () => {
    const kept = {
      PATH: '/usr/bin', HOME: '/home/me', SSH_AUTH_SOCK: '/tmp/agent',
      GH_TOKEN: 't', HTTPS_PROXY: 'http://proxy:8080', LANG: 'C', TMPDIR: '/tmp',
    }
    expect(scrubbedEnvNames(kept)).toEqual([])
    // Anything not named is dropped, including names invented after this code.
    expect(scrubbedEnvNames({ SOMETHING_NEW: 'x' })).toEqual(['SOMETHING_NEW'])
    // Windows environment names are case-insensitive.
    expect(scrubbedEnvNames({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows' })).toEqual([])
  })

  it('pins gh to the enterprise host on every call, not only the identity lookup', async () => {
    const calls: Recorded[] = []
    await backend({ pushUrl: 'ssh://git@ghe.corp.example/acme/widgets.git' }, { calls }).run(reviewInput())
    const gh = calls.filter(call => call.command === 'gh')
    expect(gh.length).toBeGreaterThan(0)
    for (const call of gh) {
      const repoIndex = call.argv.indexOf('--repo')
      const hostIndex = call.argv.indexOf('--hostname')
      // Every gh call names the host, either as --repo HOST/OWNER/REPO or --hostname.
      expect(repoIndex >= 0 || hostIndex >= 0).toBe(true)
      if (repoIndex >= 0) expect(call.argv[repoIndex + 1]).toBe('ghe.corp.example/acme/widgets')
      if (hostIndex >= 0) expect(call.argv[hostIndex + 1]).toBe('ghe.corp.example')
      expect(call.env?.GH_HOST).toBe('')
      expect(call.env?.GH_REPO).toBe('')
    }
  })

  it('pushes the reviewed commit by SHA so the branch cannot move under it', async () => {
    const calls: Recorded[] = []
    await backend({}, { calls }).run(reviewInput())
    const push = calls.find(call => call.argv.includes('push'))
    // The URL, not the remote name: a remote re-pointed after validation must not redirect the push.
    const hooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null'
    expect(push?.argv.slice(2)).toEqual([
      '-c', `core.hooksPath=${hooksPath}`,
      'push', '--no-verify', '--no-signed', '--recurse-submodules=no',
      '--', 'devloop-target', `refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
    ])
    expect(calls.flatMap(call => [...call.argv]).join(' ')).not.toMatch(/--force|\+refs/)
  })

  it('pins every gh call to the repository the push URL names, not gh\'s own guess', async () => {
    const calls: Recorded[] = []
    await backend({ pushUrl: 'https://github.com/acme/widgets.git' }, { calls }).run(reviewInput())
    const ghCalls = calls.filter(call => call.command === 'gh' && call.argv[0] === 'pr')
    expect(ghCalls.length).toBeGreaterThan(0)
    for (const call of ghCalls) {
      const index = call.argv.indexOf('--repo')
      expect(index).toBeGreaterThanOrEqual(0)
      expect(call.argv[index + 1]).toBe('github.com/acme/widgets')
      expect(call.env?.GH_REPO).toBe('')
    }
  })

  it('scopes the identity lookup to the host the remote names', async () => {
    const calls: Recorded[] = []
    await backend({ pushUrl: 'ssh://git@ghe.corp.example/acme/widgets.git' }, { calls }).run(reviewInput())
    const api = calls.find(call => call.argv[0] === 'api')
    expect(api?.argv).toEqual(['api', '--hostname', 'ghe.corp.example', 'user', '--jq', '.login'])
  })

  it('reuses an open pull request instead of opening another', async () => {
    const calls: Recorded[] = []
    await backend({}, { calls }).run(reviewInput())
    expect(calls.some(call => call.argv.join(' ').startsWith('pr create'))).toBe(false)
  })

  it('opens a pull request when none matches, then resolves its number', async () => {
    const calls: Recorded[] = []
    let listed = 0
    const runner: HeadlessRunner = async request => {
      calls.push({ command: request.command, argv: request.argv })
      const joined = request.argv.join(' ')
      if (request.command === 'git') return gitStub(joined)
      if (joined.includes('/comments')) return { stdout: '', stderr: '' }
      if (joined.startsWith('api')) return { stdout: `${SELF}\n`, stderr: '' }
      if (joined.startsWith('pr list')) {
        listed += 1
        return { stdout: JSON.stringify(listed === 1 ? [] : [pr({ number: 11, baseRefName: 'develop' })]), stderr: '' }
      }
      if (joined.startsWith('pr view')) {
        return { stdout: JSON.stringify(pr({ number: 11, baseRefName: 'develop' })), stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }
    const result = await new ForgePrBackend({ ...FAST, base: 'develop' }, runner).run(reviewInput())
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout: pull request 11/) })
    const create = calls.find(call => call.argv.join(' ').startsWith('pr create'))
    const argv = create?.argv ?? []
    // Assert the option/value pairing, not mere containment.
    expect(argv[argv.indexOf('--base') + 1]).toBe('develop')
    expect(argv[argv.indexOf('--head') + 1]).toBe(BRANCH)
    expect(argv[argv.indexOf('--title') + 1]).toBe('DevLoop TASK-1: a title')
    expect(argv[argv.indexOf('--body') + 1]).toContain(HEAD_SHA)
  })
})

describe('ForgePrBackend pull-request binding', () => {
  const mismatches: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a fork head', { isCrossRepository: true }],
    ['another base branch', { baseRefName: 'release' }],
    ['another head branch', { headRefName: 'devloop/OTHER' }],
    ['a different head commit', { headRefOid: OTHER_SHA }],
  ]

  for (const [label, override] of mismatches) {
    it(`never opens or accepts a pull request with ${label}`, async () => {
      const calls: Recorded[] = []
      const result = await backend({}, { calls, prList: [pr(override)] }).run(reviewInput())
      // No match means the adapter opens its own PR rather than adopting that one.
      expect(calls.some(call => call.argv.join(' ').startsWith('pr create'))).toBe(true)
      expect(result.status).toBe('failed')
      expect(result.outcome).toBeUndefined()
    })
  }

  it('refuses when two open pull requests claim the same head', async () => {
    await expect(backend({}, { prList: [pr(), pr({ number: 9 })] }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/2 open pull requests match/) })
  })

  it('re-checks the binding on every poll and stops if the head is retargeted', async () => {
    let views = 0
    const runner: HeadlessRunner = async request => {
      const joined = request.argv.join(' ')
      if (request.command === 'git') return gitStub(joined)
      if (joined.includes('/comments')) return { stdout: '', stderr: '' }
      if (joined.startsWith('api')) return { stdout: `${SELF}\n`, stderr: '' }
      if (joined.startsWith('pr list')) return { stdout: JSON.stringify([pr()]), stderr: '' }
      views += 1
      const moved = views >= 2 ? { headRefOid: OTHER_SHA } : {}
      return { stdout: JSON.stringify(pr(moved)), stderr: '' }
    }
    const result = await new ForgePrBackend({ ...FAST, maxWaitMs: 5_000 }, runner).run(reviewInput())
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringMatching(/no longer targets/) })
    expect(views).toBeGreaterThanOrEqual(2)
  })
})

describe('the allowlist against real git', () => {
  const scratch: string[] = []
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('keeps git from reading a config planted through XDG_CONFIG_HOME', async () => {
    const xdg = await mkdtempInRepo('devloop-forge-xdg-')
    scratch.push(xdg)
    await mkdir(join(xdg, 'git'))
    await writeFile(
      join(xdg, 'git', 'config'),
      '[credential]\n\thelper = "!touch /tmp/devloop-should-never-exist; true"\n',
      'utf8',
    )
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = xdg
    try {
      const ask = {
        command: 'git',
        argv: ['config', '--get', 'credential.helper'],
        cwd: tmpdir(),
        timeoutMs: 10_000,
      }
      // Control: git really does read this file, so the fixture is not inert.
      const seen = await defaultRunner(ask).catch(() => ({ stdout: '' }))
      expect(seen.stdout).toContain('devloop-should-never-exist')

      // Scrubbed: the same question, asked the way a forge child asks it.
      const scrubbed = await defaultRunner({ ...ask, unsetEnv: scrubbedEnvNames() })
        .catch(() => ({ stdout: '' }))
      expect(scrubbed.stdout).not.toContain('devloop-should-never-exist')
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
  })
})

describe('ForgePrBackend on a second attempt', () => {
  it('rewrites a reused pull request so it names the commit now under review', async () => {
    const calls: Recorded[] = []
    const secondSha = OTHER_SHA
    const runner: HeadlessRunner = async request => {
      calls.push({ command: request.command, argv: request.argv })
      const joined = request.argv.join(' ')
      if (request.command === 'git') return gitStub(joined, PUSH_URL, secondSha)
      if (joined.includes('/comments')) return { stdout: '', stderr: '' }
      if (joined.startsWith('api')) return { stdout: `${SELF}\n`, stderr: '' }
      if (joined.startsWith('pr list')) {
        return { stdout: JSON.stringify([pr({ headRefOid: secondSha })]), stderr: '' }
      }
      if (joined.startsWith('pr view')) return { stdout: JSON.stringify(pr({ headRefOid: secondSha })), stderr: '' }
      return { stdout: '', stderr: '' }
    }
    await new ForgePrBackend({ ...FAST }, runner).run(reviewInput(secondSha))

    // No new pull request, and the existing one is re-stated for this commit.
    expect(calls.some(call => call.argv.join(' ').startsWith('pr create'))).toBe(false)
    const edit = calls.find(call => call.argv.join(' ').startsWith('pr edit'))
    expect(edit).toBeDefined()
    const body = edit?.argv[(edit?.argv.indexOf('--body') ?? -1) + 1] ?? ''
    expect(body).toContain(secondSha)
    expect(body).not.toContain(HEAD_SHA)
  })
})

describe('ForgePrBackend verdicts', () => {
  it('uses the whole window instead of stopping a poll interval early', async () => {
    // A poll gap wider than the budget must not collapse the wait into one poll.
    const wideGap = new ForgePrBackend(
      { pollIntervalMs: 5_000, maxWaitMs: 600, reviewers: [REVIEWER], pushUrl: PUSH_URL },
      stubRunner({ comments: [] }),
    )
    const started = Date.now()
    const result = await wideGap.run(reviewInput())
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
  })

  it('polls until a verdict appears instead of asking once', async () => {
    let views = 0
    const runner = stubRunner({
      onView: count => {
        views = count
        return count >= 3 ? [comment(REVIEWER, envelope('TASK-1', HEAD_SHA))] : []
      },
    })
    const started = Date.now()
    const result = await new ForgePrBackend({ ...FAST, pollIntervalMs: 20, maxWaitMs: 5_000 }, runner).run(reviewInput())
    expect(views).toBe(3)
    // Three polls at a 20ms gap cannot have completed instantly.
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    expect(result).toMatchObject({ status: 'started', agent: `github:${REVIEWER}` })
  })

  it('accepts an authorized reviewer and reports that login to its caller', async () => {
    const result = await backend({}, {
      comments: [comment(REVIEWER, envelope('TASK-1', HEAD_SHA, 'PASS_WITH_NOTES', 'ship it'))],
    }).run(reviewInput())
    expect(result.status).toBe('started')
    expect(result.agent).toBe(`github:${REVIEWER}`)
    expect(result.outcome).toMatchObject({
      kind: 'review',
      taskId: 'TASK-1',
      reviewedSha: HEAD_SHA,
      verdict: 'PASS_WITH_NOTES',
      notes: 'ship it',
    })
  })

  it('ignores a verdict from a login that is not on the allowlist', async () => {
    await expect(backend({}, { comments: [comment('a-stranger', envelope('TASK-1', HEAD_SHA))] }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
  })

  it('ignores an allowlisted author who is also the account this host pushes as', async () => {
    // Allowlisted AND authenticated: only the self-exclusion can reject this one.
    const result = await backend({ reviewers: [REVIEWER, SELF] }, {
      login: SELF,
      comments: [comment(SELF, envelope('TASK-1', HEAD_SHA))],
    }).run(reviewInput())
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
  })

  it('never accepts a verdict written by the account the host authenticates as', async () => {
    const selfIsAllowlisted = backend({ reviewers: [SELF, REVIEWER] }, {
      comments: [comment(SELF, envelope('TASK-1', HEAD_SHA))],
    })
    await expect(selfIsAllowlisted.run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
  })

  it('matches the host account case-insensitively', async () => {
    const result = await backend({ reviewers: ['DevLoop-Bot'] }, {
      login: 'DevLoop-Bot',
      comments: [comment('devloop-bot', envelope('TASK-1', HEAD_SHA))],
    }).run(reviewInput())
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
  })

  it('ignores verdicts bound to another commit or another task', async () => {
    await expect(backend({}, { comments: [comment(REVIEWER, envelope('TASK-1', OTHER_SHA))] }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
    await expect(backend({}, { comments: [comment(REVIEWER, envelope('TASK-2', HEAD_SHA))] }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
  })

  it('ignores malformed, duplicated, and non-review envelopes', async () => {
    const bodies = [
      '<devloop_result>{"version":1,"kind":"review"}</devloop_result>',
      '<devloop_result>not json</devloop_result>',
      `${envelope('TASK-1', HEAD_SHA)}${envelope('TASK-1', HEAD_SHA)}`,
      '<devloop_result>{"version":1,"kind":"implementation","taskId":"TASK-1","outcome":"completed","summary":"x"}</devloop_result>',
      `<devloop_result>{"version":2,"kind":"review","taskId":"TASK-1","reviewedSha":"${HEAD_SHA}","verdict":"PASS"}</devloop_result>`,
    ]
    for (const body of bodies) {
      await expect(backend({}, { comments: [comment(REVIEWER, body)] }).run(reviewInput()))
        .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
    }
  })

  it('lets any dissent about this commit outrank an approval, whoever spoke last', async () => {
    const afterwards = await backend({ reviewers: [REVIEWER, 'second-reviewer'] }, {
      comments: [
        comment(REVIEWER, envelope('TASK-1', HEAD_SHA, 'PASS')),
        comment('second-reviewer', envelope('TASK-1', HEAD_SHA, 'REWORK')),
      ],
    }).run(reviewInput())
    expect(afterwards.outcome).toMatchObject({ verdict: 'REWORK' })

    // An approval posted last still loses to an existing objection.
    const beforehand = await backend({ reviewers: [REVIEWER, 'second-reviewer'] }, {
      comments: [
        comment('second-reviewer', envelope('TASK-1', HEAD_SHA, 'BLOCKED')),
        comment(REVIEWER, envelope('TASK-1', HEAD_SHA, 'PASS')),
      ],
    }).run(reviewInput())
    expect(beforehand.outcome).toMatchObject({ verdict: 'BLOCKED' })
  })

  it('takes the newest approval when nobody dissents', async () => {
    const result = await backend({}, {
      comments: [
        comment(REVIEWER, envelope('TASK-1', HEAD_SHA, 'PASS_WITH_NOTES')),
        comment(REVIEWER, envelope('TASK-1', HEAD_SHA, 'PASS')),
      ],
    }).run(reviewInput())
    expect(result.outcome).toMatchObject({ verdict: 'PASS' })
  })

  it('ignores a stale approval left on a reused pull request from an earlier attempt', async () => {
    const result = await backend({}, {
      comments: [
        comment(REVIEWER, envelope('TASK-1', OTHER_SHA, 'PASS')),
        comment(REVIEWER, 'rebuilt, taking another look'),
      ],
    }).run(reviewInput())
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
  })

  it('rejects comments whose author is not a plausible login', async () => {
    await expect(backend({}, { comments: [comment('not a login!', envelope('TASK-1', HEAD_SHA))] }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_timeout/) })
  })

  it('cannot have a dissent buried under a flood of later comments', async () => {
    const filler = Array.from({ length: 300 }, () => comment('a-stranger', 'no envelope here'))
    const result = await backend({}, {
      comments: [
        comment(REVIEWER, envelope('TASK-1', HEAD_SHA, 'REWORK')),
        ...filler,
        comment(REVIEWER, envelope('TASK-1', HEAD_SHA, 'PASS')),
      ],
    }).run(reviewInput())
    expect(result.outcome).toMatchObject({ verdict: 'REWORK' })
  })

  it('refuses a thread too large to read rather than reading part of it', async () => {
    const flood = Array.from({ length: MAX_REVIEW_COMMENTS + 1 }, () => comment('a-stranger', 'filler'))
    await expect(backend({}, { comments: flood }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/more than 2000 comments/) })
  })
})

describe('ForgePrBackend failure handling', () => {
  it('fails closed when the host identity cannot be established', async () => {
    const unavailable = backend({}, {
      comments: [comment(REVIEWER, envelope('TASK-1', HEAD_SHA))],
      fail: call => call.argv[0] === 'api' ? 'gh: not logged in' : undefined,
    })
    await expect(unavailable.run(reviewInput())).resolves.toMatchObject({
      status: 'failed',
      detail: expect.stringMatching(/forge_identity/),
    })

    const bogus = backend({}, { login: 'not a login!', comments: [comment(REVIEWER, envelope('TASK-1', HEAD_SHA))] })
    await expect(bogus.run(reviewInput())).resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/forge_identity/) })
  })

  it('reads the identity fresh on each dispatch rather than caching it', async () => {
    const calls: Recorded[] = []
    const instance = backend({}, { calls })
    await instance.run(reviewInput())
    await instance.run(reviewInput())
    expect(calls.filter(call => call.argv[0] === 'api' && call.argv.includes('user'))).toHaveLength(2)
  })

  it('rejects valid JSON with the wrong shape instead of reading it as "no verdict"', async () => {
    const shapes: ReadonlyArray<readonly [unknown, RegExp]> = [
      ['not json', /invalid JSON/],
      [{ number: 7 }, /did not return an array/],
      [[{ number: 0, baseRefName: 'main', headRefName: BRANCH, headRefOid: HEAD_SHA, isCrossRepository: false }], /number is invalid/],
      [[pr({ headRefOid: 'nope' })], /head OID is missing or malformed/],
      [[pr({ isCrossRepository: 'false' })], /cross-repository flag is missing/],
      [[pr({ baseRefName: 7 })], /refs are missing/],
      [['string entry'], /entry is not an object/],
    ]
    for (const [prList, expected] of shapes) {
      await expect(backend({}, { prList }).run(reviewInput()))
        .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(expected) })
    }
  })

  it('rejects malformed comment rows rather than treating them as empty', async () => {
    await expect(backend({}, { rawComments: 'not json' }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/comment 0.*invalid JSON/) })
    await expect(backend({}, { rawComments: '"a string"' }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/comment 0 is not an object/) })
    await expect(backend({}, { rawComments: '{"author":7,"body":"x"}' }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/missing an author or body/) })
    await expect(backend({}, { prView: [pr()] }).run(reviewInput()))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/did not return an object/) })
  })

  it('reports a failed push instead of silently waiting', async () => {
    const result = await backend({}, {
      fail: call => call.command === 'git' && call.argv.includes('push') ? 'rejected: non-fast-forward' : undefined,
    }).run(reviewInput())
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringMatching(/non-fast-forward/) })
  })

  it('takes the wait bound from the task contract when none is configured', async () => {
    const contracted = reviewInput()
    const bounded = {
      ...contracted,
      contract: { ...contracted.contract!, budget: { maxMinutes: 0, maxAttempts: 3 } },
    }
    await expect(new ForgePrBackend({ pollIntervalMs: 1, reviewers: [REVIEWER], pushUrl: PUSH_URL }, stubRunner({})).run(bounded))
      // The deadline now covers setup too, so an empty budget stops before any push.
      .resolves.toMatchObject({ detail: expect.stringMatching(/forge_timeout: review exceeded 0 minutes/) })
  })

  it('stops waiting when the host aborts the dispatch', async () => {
    const abort = new AbortController()
    const waiting = new ForgePrBackend(
      { pollIntervalMs: 50, maxWaitMs: 60_000, reviewers: [REVIEWER], pushUrl: PUSH_URL },
      stubRunner({ comments: [] }),
    )
    setTimeout(() => abort.abort(), 20)
    const started = Date.now()
    await expect(waiting.run({ ...reviewInput(), signal: abort.signal }))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/backend timeout/) })
    // Proves the abort cut the wait short rather than the 60s budget expiring.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('passes the abort signal down to every child process it starts', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const abort = new AbortController()
    const runner: HeadlessRunner = async request => {
      seen.push(request.signal)
      const joined = request.argv.join(' ')
      if (request.command === 'git') return gitStub(joined)
      if (joined.includes('/comments')) return { stdout: '', stderr: '' }
      if (joined.startsWith('api')) return { stdout: `${SELF}\n`, stderr: '' }
      if (joined.startsWith('pr list')) return { stdout: JSON.stringify([pr()]), stderr: '' }
      return { stdout: JSON.stringify(pr()), stderr: '' }
    }
    await new ForgePrBackend({ ...FAST, reviewers: [REVIEWER] }, runner)
      .run({ ...reviewInput(), signal: abort.signal })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(signal => signal === abort.signal)).toBe(true)
  })
})

/**
 * Runs the real git commands, but points the target remote at a local bare repo
 * so nothing leaves the machine, and echoes the configured URL back from
 * `remote get-url` so that redirection stays invisible to the equality check.
 * The check itself is covered without any stubbing by the global-rewrite test.
 */
async function offlineGit(request: HeadlessRun, local: string): Promise<{ stdout: string; stderr: string }> {
  if (request.argv.includes('remote') && request.argv.includes('get-url')) {
    return { stdout: `${PUSH_URL}\n`, stderr: '' }
  }
  if (request.argv.includes('remote') && request.argv.includes('add')) {
    return defaultRunner({ ...request, argv: request.argv.map(arg => arg === PUSH_URL ? local : arg) })
  }
  return defaultRunner(request)
}

describe('ForgePrBackend against real git', () => {
  const scratch: string[] = []
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('publishes the reviewed commit to a real remote without running repository hooks', async () => {
    const root = await mkdtempInRepo('devloop-forge-')
    scratch.push(root)
    await mkdir(join(root, '.devloop'))
    await initGitRepo(root)
    const remote = await mkdtempInRepo('devloop-forge-remote-')
    scratch.push(remote)
    await execFileAsync('git', ['init', '--bare', '-b', 'main', remote])
    await execFileAsync('git', ['-C', root, 'remote', 'add', 'origin', remote])
    await execFileAsync('git', ['-C', root, 'branch', BRANCH])
    const { stdout: tip } = await execFileAsync('git', ['-C', root, 'rev-parse', `refs/heads/${BRANCH}`])
    const sha = tip.trim()

    // A pre-push hook that would fail the push if hooks were honoured.
    const hooks = join(root, '.githooks')
    await mkdir(hooks, { recursive: true })
    const { writeFile, chmod } = await import('node:fs/promises')
    await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\nexit 1\n', 'utf8')
    await chmod(join(hooks, 'pre-push'), 0o755)
    await execFileAsync('git', ['-C', root, 'config', 'core.hooksPath', hooks])

    const runner: HeadlessRunner = async request => {
      if (request.command === 'git') return offlineGit(request, remote)
      const joined = request.argv.join(' ')
      if (joined.includes('/comments')) {
        return { stdout: JSON.stringify(comment(REVIEWER, envelope('TASK-1', sha))), stderr: '' }
      }
      if (joined.startsWith('api')) return { stdout: `${SELF}\n`, stderr: '' }
      if (joined.startsWith('pr list')) {
        return { stdout: JSON.stringify([pr({ number: 3, headRefOid: sha })]), stderr: '' }
      }
      return { stdout: JSON.stringify(pr({ number: 3, headRefOid: sha })), stderr: '' }
    }
    const result = await new ForgePrBackend(
      { pollIntervalMs: 1_000, maxWaitMs: 60_000, reviewers: [REVIEWER], pushUrl: PUSH_URL, verdictSource: 'comments' },
      runner,
    ).run({ ...reviewInput(sha), workspaceRoot: root })
    expect(result).toMatchObject({ status: 'started', agent: `github:${REVIEWER}` })
    const { stdout: pushed } = await execFileAsync('git', ['-C', remote, 'rev-parse', `refs/heads/${BRANCH}`])
    expect(pushed.trim()).toBe(sha)
  })
})

describe('ForgePrBackend against a hostile checkout', () => {
  const scratch: string[] = []
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('ignores a workspace insteadOf rule that would retarget the push', async () => {
    const root = await mkdtempInRepo('devloop-forge-rewrite-')
    scratch.push(root)
    await mkdir(join(root, '.devloop'))
    await initGitRepo(root)
    const honest = await mkdtempInRepo('devloop-forge-honest-')
    scratch.push(honest)
    const attacker = await mkdtempInRepo('devloop-forge-attacker-')
    scratch.push(attacker)
    await execFileAsync('git', ['init', '--bare', '-b', 'main', honest])
    await execFileAsync('git', ['init', '--bare', '-b', 'main', attacker])
    await execFileAsync('git', ['-C', root, 'branch', BRANCH])
    const { stdout: tip } = await execFileAsync('git', ['-C', root, 'rev-parse', `refs/heads/${BRANCH}`])
    const sha = tip.trim()

    // The checkout tries to redirect anything aimed at the honest repository.
    await execFileAsync('git', ['-C', root, 'remote', 'add', 'origin', honest])
    // Aimed at the URL git is actually handed, so this rule WOULD fire if any
    // part of the publish ran in the workspace instead of the scratch repo.
    await execFileAsync('git', ['-C', root, 'config', `url.${attacker}.pushInsteadOf`, honest])
    await execFileAsync('git', ['-C', root, 'config', `url.${attacker}.insteadOf`, honest])

    const runner: HeadlessRunner = async request => {
      if (request.command === 'git') return offlineGit(request, honest)
      const joined = request.argv.join(' ')
      if (joined.includes('/comments')) {
        return { stdout: JSON.stringify(comment(REVIEWER, envelope('TASK-1', sha))), stderr: '' }
      }
      if (joined.startsWith('api')) return { stdout: `${SELF}\n`, stderr: '' }
      if (joined.startsWith('pr list')) {
        return { stdout: JSON.stringify([pr({ number: 5, headRefOid: sha })]), stderr: '' }
      }
      return { stdout: JSON.stringify(pr({ number: 5, headRefOid: sha })), stderr: '' }
    }
    const result = await new ForgePrBackend(
      { pollIntervalMs: 1_000, maxWaitMs: 60_000, reviewers: [REVIEWER], pushUrl: PUSH_URL, verdictSource: 'comments' },
      runner,
    ).run({ ...reviewInput(sha), workspaceRoot: root })
    expect(result).toMatchObject({ status: 'started' })

    const { stdout: landed } = await execFileAsync('git', ['-C', honest, 'rev-parse', `refs/heads/${BRANCH}`])
    expect(landed.trim()).toBe(sha)
    // The attacker's repository never received the branch.
    await expect(execFileAsync('git', ['-C', attacker, 'rev-parse', `refs/heads/${BRANCH}`])).rejects.toThrow()
  })

  it('refuses a global pushInsteadOf rule that would redirect the push', async () => {
    const root = await mkdtempInRepo('devloop-forge-global-')
    scratch.push(root)
    await mkdir(join(root, '.devloop'))
    await initGitRepo(root)
    const attacker = await mkdtempInRepo('devloop-forge-global-attacker-')
    scratch.push(attacker)
    await execFileAsync('git', ['init', '--bare', '-b', 'main', attacker])
    await execFileAsync('git', ['-C', root, 'branch', BRANCH])
    const { stdout: tip } = await execFileAsync('git', ['-C', root, 'rev-parse', `refs/heads/${BRANCH}`])
    const sha = tip.trim()

    // A global rule, injected through GIT_CONFIG_GLOBAL so the real ~/.gitconfig
    // is untouched. `ls-remote --get-url` does NOT expand pushInsteadOf, but the
    // push does, so only asking the way the push asks can catch this.
    const configDir = await mkdtempInRepo('devloop-forge-global-cfg-')
    scratch.push(configDir)
    const globalConfig = join(configDir, 'gitconfig')
    await writeFile(globalConfig, `[url "${attacker}"]\n\tpushInsteadOf = ${PUSH_URL}\n`, 'utf8')

    const runner: HeadlessRunner = async request => {
      if (request.command !== 'git') {
        return request.argv.join(' ').startsWith('api')
          ? { stdout: `${SELF}\n`, stderr: '' }
          : { stdout: '', stderr: '' }
      }
      return defaultRunner({ ...request, env: { ...request.env, GIT_CONFIG_GLOBAL: globalConfig } })
    }
    const result = await new ForgePrBackend(
      { pollIntervalMs: 1_000, maxWaitMs: 60_000, reviewers: [REVIEWER], pushUrl: PUSH_URL, verdictSource: 'comments' },
      runner,
    ).run({ ...reviewInput(sha), workspaceRoot: root })

    expect(result).toMatchObject({ status: 'failed', detail: expect.stringMatching(/rewrites/) })
    await expect(execFileAsync('git', ['-C', attacker, 'rev-parse', `refs/heads/${BRANCH}`])).rejects.toThrow()
  })

  it('works when the workspace root is relative', async () => {
    const root = await mkdtempInRepo('devloop-forge-rel-')
    scratch.push(root)
    await mkdir(join(root, '.devloop'))
    await initGitRepo(root)
    const remote = await mkdtempInRepo('devloop-forge-rel-remote-')
    scratch.push(remote)
    await execFileAsync('git', ['init', '--bare', '-b', 'main', remote])
    await execFileAsync('git', ['-C', root, 'branch', BRANCH])
    const { stdout: tip } = await execFileAsync('git', ['-C', root, 'rev-parse', `refs/heads/${BRANCH}`])
    const sha = tip.trim()

    const runner: HeadlessRunner = async request => {
      if (request.command === 'git') return offlineGit(request, remote)
      const joined = request.argv.join(' ')
      if (joined.includes('/comments')) {
        return { stdout: JSON.stringify(comment(REVIEWER, envelope('TASK-1', sha))), stderr: '' }
      }
      if (joined.startsWith('api')) return { stdout: `${SELF}\n`, stderr: '' }
      if (joined.startsWith('pr list')) {
        return { stdout: JSON.stringify([pr({ number: 9, headRefOid: sha })]), stderr: '' }
      }
      return { stdout: JSON.stringify(pr({ number: 9, headRefOid: sha })), stderr: '' }
    }
    const relative = relativePath(process.cwd(), root)
    expect(isAbsolute(relative)).toBe(false)
    const result = await new ForgePrBackend(
      { pollIntervalMs: 1_000, maxWaitMs: 60_000, reviewers: [REVIEWER], pushUrl: PUSH_URL, verdictSource: 'comments' },
      runner,
    ).run({ ...reviewInput(sha), workspaceRoot: relative })

    expect(result).toMatchObject({ status: 'started' })
    const { stdout: landed } = await execFileAsync('git', ['-C', remote, 'rev-parse', `refs/heads/${BRANCH}`])
    expect(landed.trim()).toBe(sha)
  })

  it('borrows objects from a path containing the alternates separator', async () => {
    const base = await mkdtempInRepo('devloop-forge-sep-')
    scratch.push(base)
    const root = join(base, 'a:b')
    await mkdir(root)
    await mkdir(join(root, '.devloop'))
    await initGitRepo(root)
    const remote = await mkdtempInRepo('devloop-forge-sep-remote-')
    scratch.push(remote)
    await execFileAsync('git', ['init', '--bare', '-b', 'main', remote])
    await execFileAsync('git', ['-C', root, 'branch', BRANCH])
    const { stdout: tip } = await execFileAsync('git', ['-C', root, 'rev-parse', `refs/heads/${BRANCH}`])
    const sha = tip.trim()

    const runner: HeadlessRunner = async request => {
      if (request.command === 'git') return offlineGit(request, remote)
      const joined = request.argv.join(' ')
      if (joined.includes('/comments')) {
        return { stdout: JSON.stringify(comment(REVIEWER, envelope('TASK-1', sha))), stderr: '' }
      }
      if (joined.startsWith('api')) return { stdout: `${SELF}\n`, stderr: '' }
      if (joined.startsWith('pr list')) {
        return { stdout: JSON.stringify([pr({ number: 6, headRefOid: sha })]), stderr: '' }
      }
      return { stdout: JSON.stringify(pr({ number: 6, headRefOid: sha })), stderr: '' }
    }
    const result = await new ForgePrBackend(
      { pollIntervalMs: 1_000, maxWaitMs: 60_000, reviewers: [REVIEWER], pushUrl: PUSH_URL, verdictSource: 'comments' },
      runner,
    ).run({ ...reviewInput(sha), workspaceRoot: root })
    expect(result).toMatchObject({ status: 'started' })
    const { stdout: landed } = await execFileAsync('git', ['-C', remote, 'rev-parse', `refs/heads/${BRANCH}`])
    expect(landed.trim()).toBe(sha)
  })
})

describe('quoteAlternate', () => {
  it('quotes only what git would otherwise split or mis-read', () => {
    expect(quoteAlternate('/tmp/plain/objects')).toBe('/tmp/plain/objects')
    const separator = process.platform === 'win32' ? ';' : ':'
    expect(quoteAlternate(`/tmp/a${separator}b/objects`)).toBe(`"/tmp/a${separator}b/objects"`)
    expect(quoteAlternate('/tmp/a"b/objects')).toBe('"/tmp/a\\"b/objects"')
  })
})

describe('pullRequestBody', () => {
  it('names the exact commit, the envelope, and who may answer', () => {
    const body = pullRequestBody('TASK-1', HEAD_SHA, [REVIEWER], 'comments')
    expect(body).toContain(HEAD_SHA)
    expect(body).toContain('TASK-1')
    expect(body).toContain(`\`${REVIEWER}\``)
    // The instruction block must carry the same task and SHA the verdict is checked against.
    const envelopeLine = body.slice(body.indexOf('<devloop_result>'))
    expect(envelopeLine).toContain(`"taskId":"TASK-1"`)
    expect(envelopeLine).toContain(`"reviewedSha":"${HEAD_SHA}"`)
  })
})

describe('routing review to the forge', () => {
  it('sends review to the forge adapter while implementation stays on its tier', async () => {
    const forge = new RecordingBackend()
    const worker = new RecordingBackend()
    const config = resolveConfig({
      reviewerRoute: { tier: 'T3', backend: 'forge', model: 'pull-request' },
    })
    const routed = new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, { forge, dsh: worker })

    const state = withTasks(baseState(), [makeTask({ id: 'TASK-1', status: 'review_pending' })])
    await routed.run(runInputFor('/repo', { type: 'delegate', taskId: 'TASK-1' }, state, config.budget))
    await routed.run(runInputFor('/repo', { type: 'review', taskId: 'TASK-1' }, state, config.budget))

    expect(worker.runs.map(run => run.action.type)).toEqual(['delegate'])
    expect(forge.runs.map(run => run.action.type)).toEqual(['review'])
    expect(forge.runs[0]?.route).toEqual(config.reviewerRoute)
  })

  it('records the route label, not the reviewer login, once routed', async () => {
    // RoutedBackend deliberately overwrites an adapter's self-reported identity,
    // so STATE names the route. Which allowlisted person approved lives on the
    // pull request; the forge adapter is what enforces that they were authorized.
    const forge: AgentBackend = {
      async run() { return { status: 'started', agent: 'github:a-reviewer' } },
      async cancel() {},
      async health() { return 'ok' },
    }
    const config = resolveConfig({ reviewerRoute: { tier: 'T3', backend: 'forge', model: 'pull-request' } })
    const routed = new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, { forge })
    const state = withTasks(baseState(), [makeTask({ id: 'TASK-1', status: 'review_pending' })])
    await expect(routed.run(runInputFor('/repo', { type: 'review', taskId: 'TASK-1' }, state, config.budget)))
      .resolves.toMatchObject({ agent: 'forge/pull-request' })
  })

  it('is rejected as a reviewer when the implementer tier already uses it', async () => {
    const config = resolveConfig({
      reviewerRoute: { tier: 'T3', backend: 'forge', model: 'pull-request' },
      routing: { T1: { tier: 'T1', backend: 'forge', model: 'pull-request' } },
    })
    const routed = new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, { forge: new RecordingBackend() })
    const state = withTasks(baseState(), [makeTask({ id: 'TASK-1', status: 'review_pending' })])
    await expect(routed.run(runInputFor('/repo', { type: 'review', taskId: 'TASK-1' }, state, config.budget)))
      .resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(/review route must differ/) })
  })
})

describe('ForgePrBackend verdicts from GitHub reviews', () => {
  const review = (author: string, state: string, commit = HEAD_SHA, body = '') => ({ author, state, commit, body })
  const onReviews = (reviews: unknown[], overrides: Partial<ForgeOptions> = {}) =>
    backend({ verdictSource: 'reviews', ...overrides }, { reviews }).run(reviewInput())

  it('reads the pull request\'s reviews, not its comments, and passes an approval of this commit', async () => {
    const calls: Recorded[] = []
    const result = await backend({ verdictSource: 'reviews' }, { reviews: [review(REVIEWER, 'APPROVED')], comments: [comment(REVIEWER, envelope('TASK-1', HEAD_SHA, 'REWORK'))], calls }).run(reviewInput())
    expect(result).toMatchObject({ status: 'started', agent: `github:${REVIEWER}`, outcome: { kind: 'review', taskId: 'TASK-1', reviewedSha: HEAD_SHA, verdict: 'PASS' } })
    expect(calls.some(call => call.argv.join(' ').includes('repos/acme/widgets/pulls/7/reviews'))).toBe(true)
    expect(calls.some(call => call.argv.join(' ').includes('/comments'))).toBe(false)
  })

  it('turns a request for changes into rework, with the review body as the notes', async () => {
    const result = await onReviews([review(REVIEWER, 'CHANGES_REQUESTED', HEAD_SHA, '  Split the parser out.  ')])
    expect(result).toMatchObject({ status: 'started', outcome: { verdict: 'REWORK', notes: 'Split the parser out.' } })
  })

  it('lets one reviewer\'s request for changes outrank another\'s approval, and a reviewer\'s later word replace their earlier one', async () => {
    const two = { reviewers: [REVIEWER, 'b-reviewer'] }
    expect((await onReviews([review(REVIEWER, 'APPROVED'), review('b-reviewer', 'CHANGES_REQUESTED')], two)).outcome).toMatchObject({ verdict: 'REWORK' })
    expect((await onReviews([review(REVIEWER, 'CHANGES_REQUESTED'), review(REVIEWER, 'APPROVED')])).outcome).toMatchObject({ verdict: 'PASS' })
    expect((await onReviews([review(REVIEWER, 'APPROVED'), review(REVIEWER, 'CHANGES_REQUESTED')])).outcome).toMatchObject({ verdict: 'REWORK' })
  })

  it('waits on reviews of another commit, comments-only reviews, strangers and itself', async () => {
    for (const reviews of [
      [review(REVIEWER, 'APPROVED', OTHER_SHA)],
      [review(REVIEWER, 'COMMENTED'), review(REVIEWER, 'DISMISSED'), review(REVIEWER, 'PENDING')],
      [review('a-stranger', 'APPROVED')],
      [review(SELF, 'APPROVED')],
      [review('not a login!', 'APPROVED')],
    ]) {
      const result = await onReviews(reviews, { reviewers: [REVIEWER, SELF] })
      expect(result, JSON.stringify(reviews)).toMatchObject({ status: 'failed' })
      expect(result.detail).toMatch(/^forge_timeout:/)
    }
  })

  it('refuses a review row it cannot read, and a list too long to read whole', async () => {
    expect((await onReviews([{ author: REVIEWER, state: 'APPROVED' }])).detail).toMatch(/missing an author, state or commit/)
    const flood = Array.from({ length: MAX_REVIEW_COMMENTS + 1 }, () => review(REVIEWER, 'COMMENTED'))
    expect((await onReviews(flood)).detail).toMatch(/more than \d+ reviews/)
  })

  it('reads reviews unless configured otherwise', () => {
    expect(resolveConfig({}).forge.verdictSource).toBe('reviews')
    expect(resolveConfig({ forge: { pushUrl: PUSH_URL, reviewers: [REVIEWER] } } as never).forge.verdictSource).toBe('reviews')
  })

  it('tells the reviewer to decide with a review of this commit, and that comments are not read', () => {
    const body = pullRequestBody('TASK-1', HEAD_SHA, [REVIEWER])
    expect(body).toContain('Request changes')
    expect(body).toContain(HEAD_SHA)
    expect(body).toContain('Comments are not read')
    expect(body).not.toContain('<devloop_result>')
    // Nothing at this commit hands the body to the worker, so the pull request must not promise it.
    expect(body).not.toMatch(/worker is given|next attempt/)
  })

  it('takes a dismissed review as withdrawn, not as bringing back the one before it', async () => {
    expect((await onReviews([review(REVIEWER, 'APPROVED'), review(REVIEWER, 'CHANGES_REQUESTED'), review(REVIEWER, 'DISMISSED')])).detail).toMatch(/^forge_timeout:/)
    expect((await onReviews([review(REVIEWER, 'APPROVED'), review(REVIEWER, 'DISMISSED'), review(REVIEWER, 'APPROVED')])).outcome).toMatchObject({ verdict: 'PASS' })
  })

  it('keeps every reviewer\'s request for changes, and marks notes it had to cut', async () => {
    const both = await onReviews([review(REVIEWER, 'CHANGES_REQUESTED', HEAD_SHA, 'split it'), review('b-reviewer', 'CHANGES_REQUESTED', HEAD_SHA, 'add a test')], { reviewers: [REVIEWER, 'b-reviewer'] })
    expect(both.outcome).toMatchObject({ verdict: 'REWORK', notes: `${REVIEWER}: split it\n\nb-reviewer: add a test` })
    const long = await onReviews([review(REVIEWER, 'CHANGES_REQUESTED', HEAD_SHA, 'x'.repeat(9_000))])
    const notes = (long.outcome as { notes?: string }).notes ?? ''
    expect(notes.length).toBe(8_000)
    expect(notes.endsWith('\n[truncated]')).toBe(true)
  })
})
