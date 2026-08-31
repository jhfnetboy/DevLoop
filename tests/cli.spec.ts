import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { NoopBackend, runInputFor } from '../src/backend.ts'
import type { HeadlessRun } from '../src/dsh.ts'
import { DshHeadlessBackend, headlessPrompt } from '../src/dsh.ts'
import { ClaudeCliBackend, CodexCliBackend } from '../src/cli.ts'
import { resolveConfig } from '../src/config.ts'
import DevloopService from '../src/service.ts'
import { baseState, makeTask } from './helpers.ts'

const limits = resolveConfig({}).budget

function fakeRunner(calls: HeadlessRun[]) {
  return async (request: HeadlessRun) => {
    calls.push(request)
    return { stdout: '', stderr: '' }
  }
}

function reviewInput(worktreeRoot: string) {
  return {
    ...runInputFor(
      '/repo',
      { type: 'review', taskId: 'd1' },
      baseState({ tasks: [makeTask({ id: 'd1', status: 'review_pending', title: 'Add persist' })] }),
      limits,
    ),
    worktreeRoot,
  }
}

function planInput(worktreeRoot: string | null) {
  return {
    ...runInputFor('/repo', { type: 'plan' }, baseState(), limits),
    workspaceRoot: '/repo',
    worktreeRoot,
  }
}

function delegateInput(worktreeRoot: string) {
  return {
    ...runInputFor(
      '/repo',
      { type: 'delegate', taskId: 'd1' },
      baseState({ tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })] }),
      limits,
    ),
    worktreeRoot,
  }
}

describe('ClaudeCliBackend', () => {
  it('runs claude -p --permission-mode plan for review without write access', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(fakeRunner(calls))
    const input = reviewInput('/repo/.devloop/worktrees/d1')
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    expect(calls[0]?.command).toBe('claude')
    expect(calls[0]?.argv).toEqual([
      '-p',
      '--permission-mode',
      'plan',
      expect.stringContaining('Review task d1'),
    ])
    expect(calls[0]?.argv[3]).toContain('Do not edit files')
    expect(calls[0]?.cwd).toBe('/repo/.devloop/worktrees/d1')
    expect(calls[0]?.timeoutMs).toBe(limits.taskTimeoutMinutes * 60_000)
  })

  it('uses acceptEdits for delegate and asks for a commit', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(fakeRunner(calls))
    await backend.run(delegateInput('/repo/.devloop/worktrees/d1'))
    expect(calls[0]?.argv).toEqual([
      '-p',
      '--permission-mode',
      'acceptEdits',
      '--',
      expect.stringContaining('Execute task d1'),
    ])
    expect(calls[0]?.argv.at(-1)).toContain('Do not run git')
    expect(calls[0]?.argv).not.toContain('--allowedTools')
  })

  it('passes a routed model to Claude CLI', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(fakeRunner(calls))
    await backend.run({
      ...reviewInput('/repo/.devloop/worktrees/d1'),
      route: { tier: 'T3', backend: 'claude', model: 'opus' },
    })
    expect(calls[0]?.argv.slice(0, 5)).toEqual([
      '-p', '--model', 'opus', '--permission-mode', 'plan',
    ])
  })

  it('uses permission-mode plan for plan ticks', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(fakeRunner(calls))
    await backend.run(planInput('/repo/.devloop/worktrees/_loop-plan'))
    expect(calls[0]?.argv).toEqual([
      '-p',
      '--permission-mode',
      'plan',
      expect.stringContaining('GOAL.md'),
    ])
    expect(calls[0]?.timeoutMs).toBe(45 * 60_000)
  })

  it('refuses to run at the workspace root', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(fakeRunner(calls))
    await expect(backend.run(planInput(null))).resolves.toEqual({
      status: 'failed',
      detail: 'refusing to run T3 CLI at workspace root',
    })
    expect(calls).toHaveLength(0)
  })

  it('refuses when worktreeRoot is the workspace root', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(fakeRunner(calls))
    await expect(backend.run(planInput('/repo'))).resolves.toEqual({
      status: 'failed',
      detail: 'refusing to run T3 CLI at workspace root',
    })
    expect(calls).toHaveLength(0)
  })

  it('writes plan stdout to workspace PLAN.md before the caller drops the worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-plan-out-'))
    await mkdir(join(root, '.devloop'))
    const backend = new ClaudeCliBackend(async () => ({ stdout: '# Tasks\n- one\n', stderr: '' }))
    await expect(backend.run({
      ...planInput(join(root, 'wt')),
      workspaceRoot: root,
    })).resolves.toEqual({ status: 'started' })
    await expect(readFile(join(root, '.devloop', 'PLAN.md'), 'utf8')).resolves.toBe('# Tasks\n- one\n')
  })

  it('writes review stdout to workspace REVIEW.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-review-out-'))
    await mkdir(join(root, '.devloop'))
    const backend = new ClaudeCliBackend(async () => ({ stdout: 'PASS\n', stderr: '' }))
    await expect(backend.run({
      ...reviewInput(join(root, 'wt')),
      workspaceRoot: root,
    })).resolves.toEqual({ status: 'started' })
    await expect(readFile(join(root, '.devloop', 'REVIEW.md'), 'utf8')).resolves.toBe('PASS\n')
  })

  it('atomically replaces an existing regular PLAN.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-plan-replace-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'PLAN.md'), '# old\n', 'utf8')
    const backend = new ClaudeCliBackend(async () => ({ stdout: '# new', stderr: '' }))
    await expect(backend.run({
      ...planInput(join(root, 'wt')),
      workspaceRoot: root,
    })).resolves.toEqual({ status: 'started' })
    await expect(readFile(join(root, '.devloop', 'PLAN.md'), 'utf8')).resolves.toBe('# new\n')
  })

  it('refuses a symlink PLAN.md without changing its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-plan-symlink-'))
    await mkdir(join(root, '.devloop'))
    const victim = join(root, 'victim.txt')
    await writeFile(victim, 'keep\n', 'utf8')
    await symlink(victim, join(root, '.devloop', 'PLAN.md'))
    const backend = new ClaudeCliBackend(async () => ({ stdout: '# unsafe\n', stderr: '' }))
    await expect(backend.run({
      ...planInput(join(root, 'wt')),
      workspaceRoot: root,
    })).resolves.toEqual({ status: 'failed', detail: 'refusing symlink PLAN.md' })
    await expect(readFile(victim, 'utf8')).resolves.toBe('keep\n')
  })

  it('removes a stale PLAN.md when a later plan emits only whitespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-plan-empty-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'PLAN.md'), '# old plan\n', 'utf8')
    const backend = new ClaudeCliBackend(async () => ({ stdout: '  \n', stderr: '' }))
    await expect(backend.run({
      ...planInput(join(root, 'wt')),
      workspaceRoot: root,
    })).resolves.toEqual({ status: 'started' })
    await expect(access(join(root, '.devloop', 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a missing PLAN.md missing when plan stdout is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-plan-missing-'))
    await mkdir(join(root, '.devloop'))
    const backend = new ClaudeCliBackend(async () => ({ stdout: '', stderr: '' }))
    await expect(backend.run({
      ...planInput(join(root, 'wt')),
      workspaceRoot: root,
    })).resolves.toEqual({ status: 'started' })
    await expect(access(join(root, '.devloop', 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('passes permission-mode and the prompt as separate argv entries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-claude-argv-'))
    const command = fileURLToPath(new URL('./fixtures/echo-argv.mjs', import.meta.url))
    await chmod(command, 0o755)
    const backend = new ClaudeCliBackend(undefined, command)
    const input = planInput(cwd)
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    const argv = JSON.parse(await readFile(join(cwd, 'argv.json'), 'utf8')) as string[]
    expect(argv).toEqual(['-p', '--permission-mode', 'plan', headlessPrompt(input)])
  })

  it('returns failed when the runner throws', async () => {
    const backend = new ClaudeCliBackend(async () => {
      throw new Error('spawn ENOENT')
    })
    await expect(backend.run(planInput('/repo/.devloop/worktrees/_loop-plan'))).resolves.toEqual({
      status: 'failed',
      detail: 'spawn ENOENT',
    })
  })

  it('retries one malformed result as a protocol-only repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-cli-repair-'))
    await mkdir(join(root, '.devloop'))
    const calls: HeadlessRun[] = []
    const valid = '<devloop_result>{"version":1,"kind":"review","taskId":"d1","reviewedSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","verdict":"PASS"}</devloop_result>'
    const backend = new ClaudeCliBackend(async request => {
      calls.push(request)
      return { stdout: calls.length === 1 ? '<devloop_result>{broken}</devloop_result>' : valid, stderr: '' }
    })
    const result = await backend.run({
      ...reviewInput(join(root, '.devloop', 'worktrees', 'd1')),
      workspaceRoot: root,
    })
    expect(result).toMatchObject({ status: 'started', outcome: { kind: 'review', verdict: 'PASS' } })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.argv.at(-1)).toContain('Do not make additional edits')
  })

  it('fails closed after two malformed protocol results', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(async request => {
      calls.push(request)
      return { stdout: '<devloop_result>{broken}</devloop_result>', stderr: '' }
    })
    await expect(backend.run(reviewInput('/repo/.devloop/worktrees/d1'))).resolves.toEqual({
      status: 'failed',
      detail: 'invalid devloop_result JSON',
    })
    expect(calls).toHaveLength(2)
  })

  it('forwards AbortSignal to the runner', async () => {
    const abort = new AbortController()
    let seen: AbortSignal | undefined
    const backend = new ClaudeCliBackend(async request => {
      seen = request.signal
      return { stdout: '', stderr: '' }
    })
    await backend.run({
      ...planInput('/repo/.devloop/worktrees/_loop-plan'),
      signal: abort.signal,
    })
    expect(seen).toBe(abort.signal)
  })

  it('probes --help for health', async () => {
    const calls: HeadlessRun[] = []
    const ok = new ClaudeCliBackend(fakeRunner(calls))
    await expect(ok.health()).resolves.toBe('ok')
    expect(calls[0]?.command).toBe('claude')
    expect(calls[0]?.argv).toEqual(['--help'])
    const down = new ClaudeCliBackend(async () => {
      throw new Error('missing')
    })
    await expect(down.health()).resolves.toBe('down')
  })
})

describe('CodexCliBackend', () => {
  it('runs codex exec --sandbox read-only for review', async () => {
    const calls: HeadlessRun[] = []
    const backend = new CodexCliBackend(fakeRunner(calls))
    const input = reviewInput('/repo/.devloop/worktrees/d1')
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    expect(calls[0]?.command).toBe('codex')
    expect(calls[0]?.argv).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      expect.stringContaining('Review task d1'),
    ])
    expect(calls[0]?.argv[3]).toContain('Do not edit files')
    expect(calls[0]?.cwd).toBe('/repo/.devloop/worktrees/d1')
    expect(calls[0]?.timeoutMs).toBe(limits.taskTimeoutMinutes * 60_000)
  })

  it('uses workspace-write for delegate and asks for a commit', async () => {
    const calls: HeadlessRun[] = []
    const backend = new CodexCliBackend(fakeRunner(calls))
    await backend.run(delegateInput('/repo/.devloop/worktrees/d1'))
    expect(calls[0]?.argv).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      '/repo/.git/worktrees/d1',
      expect.stringContaining('Execute task d1'),
    ])
    expect(calls[0]?.argv.at(-1)).toContain('Do not run git')
  })

  it('passes a routed model to Codex CLI', async () => {
    const calls: HeadlessRun[] = []
    const backend = new CodexCliBackend(fakeRunner(calls))
    await backend.run({
      ...reviewInput('/repo/.devloop/worktrees/d1'),
      route: { tier: 'T3', backend: 'codex', model: 'gpt-5.4' },
    })
    expect(calls[0]?.argv.slice(0, 6)).toEqual([
      'exec', '--sandbox', 'read-only', '--model', 'gpt-5.4',
      expect.stringContaining('Review task d1'),
    ])
  })

  it('adds the gitdir from a linked worktree .git file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-codex-gitdir-'))
    const wt = join(root, 'wt')
    await mkdir(wt)
    await writeFile(join(wt, '.git'), 'gitdir: /abs/git/worktrees/custom-name\n', 'utf8')
    const calls: HeadlessRun[] = []
    const backend = new CodexCliBackend(fakeRunner(calls))
    await backend.run({
      ...delegateInput(wt),
      workspaceRoot: root,
    })
    expect(calls[0]?.argv).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      '/abs/git/worktrees/custom-name',
      expect.stringContaining('Execute task d1'),
    ])
  })

  it('uses read-only sandbox for plan ticks', async () => {
    const calls: HeadlessRun[] = []
    const backend = new CodexCliBackend(fakeRunner(calls))
    await backend.run(planInput('/repo/.devloop/worktrees/_loop-plan'))
    expect(calls[0]?.argv).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      expect.stringContaining('GOAL.md'),
    ])
    expect(calls[0]?.timeoutMs).toBe(45 * 60_000)
  })

  it('refuses to run at the workspace root', async () => {
    const calls: HeadlessRun[] = []
    const backend = new CodexCliBackend(fakeRunner(calls))
    await expect(backend.run(planInput(null))).resolves.toEqual({
      status: 'failed',
      detail: 'refusing to run T3 CLI at workspace root',
    })
    expect(calls).toHaveLength(0)
  })

  it('passes sandbox and the prompt as separate argv entries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-codex-argv-'))
    const command = fileURLToPath(new URL('./fixtures/echo-argv.mjs', import.meta.url))
    await chmod(command, 0o755)
    const backend = new CodexCliBackend(undefined, command)
    const input = planInput(cwd)
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    const argv = JSON.parse(await readFile(join(cwd, 'argv.json'), 'utf8')) as string[]
    expect(argv).toEqual(['exec', '--sandbox', 'read-only', headlessPrompt(input)])
  })

  it('does not hang when the child reads stdin to EOF', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-codex-stdin-'))
    const command = fileURLToPath(new URL('./fixtures/read-stdin-then-argv.mjs', import.meta.url))
    await chmod(command, 0o755)
    const backend = new CodexCliBackend(undefined, command)
    await expect(backend.run(planInput(cwd))).resolves.toEqual({ status: 'started' })
    await expect(readFile(join(cwd, 'stdin-eof.txt'), 'utf8')).resolves.toBe('ok')
  }, 5_000)

  it('reaps a hung child before run() returns after abort', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-codex-hang-'))
    const command = fileURLToPath(new URL('./fixtures/hang.mjs', import.meta.url))
    await chmod(command, 0o755)
    const abort = new AbortController()
    const backend = new CodexCliBackend(undefined, command)
    const running = backend.run({
      ...planInput(cwd),
      signal: abort.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 80))
    abort.abort()
    const started = Date.now()
    await expect(running).resolves.toEqual({ status: 'failed', detail: 'backend timeout' })
    expect(Date.now() - started).toBeLessThan(4_000)
  }, 8_000)

  it('returns failed when the runner throws', async () => {
    const backend = new CodexCliBackend(async () => {
      throw new Error('spawn ENOENT')
    })
    await expect(backend.run(planInput('/repo/.devloop/worktrees/_loop-plan'))).resolves.toEqual({
      status: 'failed',
      detail: 'spawn ENOENT',
    })
  })

  it('forwards AbortSignal to the runner', async () => {
    const abort = new AbortController()
    let seen: AbortSignal | undefined
    const backend = new CodexCliBackend(async request => {
      seen = request.signal
      return { stdout: '', stderr: '' }
    })
    await backend.run({
      ...planInput('/repo/.devloop/worktrees/_loop-plan'),
      signal: abort.signal,
    })
    expect(seen).toBe(abort.signal)
  })

  it('probes --help for health', async () => {
    const calls: HeadlessRun[] = []
    const ok = new CodexCliBackend(fakeRunner(calls))
    await expect(ok.health()).resolves.toBe('ok')
    expect(calls[0]?.command).toBe('codex')
    expect(calls[0]?.argv).toEqual(['--help'])
    const down = new CodexCliBackend(async () => {
      throw new Error('missing')
    })
    await expect(down.health()).resolves.toBe('down')
  })
})

describe('createBackend T3 CLIs', () => {
  it('keeps NoopBackend when agentBackend is omitted', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root: '/tmp', enabled: false }))
    expect(service.backend).toBeInstanceOf(NoopBackend)
  })

  it('returns ClaudeCliBackend when cordis passes agentBackend=claude', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root: '/tmp',
      enabled: false,
      agentBackend: 'claude',
    }))
    expect(service.backend).toBeInstanceOf(ClaudeCliBackend)
  })

  it('returns CodexCliBackend when cordis passes agentBackend=codex', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root: '/tmp',
      enabled: false,
      agentBackend: 'codex',
    }))
    expect(service.backend).toBeInstanceOf(CodexCliBackend)
  })

  it('still returns DshHeadlessBackend when agentBackend=dsh', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root: '/tmp',
      enabled: false,
      agentBackend: 'dsh',
    }))
    expect(service.backend).toBeInstanceOf(DshHeadlessBackend)
  })
})
