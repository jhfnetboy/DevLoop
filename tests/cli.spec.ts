import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { NoopBackend, runInputFor } from '../src/backend.ts'
import type { HeadlessRun, HeadlessRunner } from '../src/dsh.ts'
import { DshHeadlessBackend, headlessPrompt } from '../src/dsh.ts'
import { ClaudeCliBackend, CodexCliBackend } from '../src/cli.ts'
import { resolveConfig } from '../src/config.ts'
import DevloopService from '../src/service.ts'
import { baseState, makeTask, mkdtempInRepo } from './helpers.ts'

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
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
      expect.stringContaining('Review task d1'),
    ])
    expect(calls[0]?.argv.at(-1)).toContain('Do not edit files')
    expect(calls[0]?.cwd).toBe('/repo/.devloop/worktrees/d1')
    expect(calls[0]?.timeoutMs).toBe(limits.taskTimeoutMinutes * 60_000)
  })

  it('uses acceptEdits for delegate and asks for a commit', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(fakeRunner(calls))
    await backend.run(delegateInput('/repo/.devloop/worktrees/d1'))
    expect(calls[0]?.argv).toEqual([
      '-p',
      '--output-format',
      'json',
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
    expect(calls[0]?.argv.slice(0, 7)).toEqual([
      '-p', '--model', 'opus', '--output-format', 'json', '--permission-mode', 'plan',
    ])
  })

  it('uses permission-mode plan for plan ticks', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(fakeRunner(calls))
    await backend.run(planInput('/repo/.devloop/worktrees/_loop-plan'))
    expect(calls[0]?.argv).toEqual([
      '-p',
      '--output-format',
      'json',
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
    expect(argv).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'plan', headlessPrompt(input)])
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

  it('downgrades a Claude delegate protocol repair to plan permission', async () => {
    const calls: HeadlessRun[] = []
    const valid = '<devloop_result>{"version":1,"kind":"implementation","taskId":"d1","outcome":"completed","summary":"done"}</devloop_result>'
    const backend = new ClaudeCliBackend(async request => {
      calls.push(request)
      return { stdout: calls.length === 1 ? '<devloop_result>{broken}</devloop_result>' : valid, stderr: '' }
    })
    await expect(backend.run(delegateInput('/repo/.devloop/worktrees/d1')))
      .resolves.toMatchObject({ status: 'started', outcome: { kind: 'implementation' } })
    expect(calls[0]?.argv).toContain('acceptEdits')
    expect(calls[1]?.argv).toContain('plan')
    expect(calls[1]?.argv).not.toContain('acceptEdits')
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

describe('what the backends report to the budget', () => {
  const scratch: string[] = []
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  /** A real workspace: the operator notes are written for real here. */
  async function workspace(): Promise<string> {
    const root = await mkdtempInRepo('devloop-signals-')
    scratch.push(root)
    await mkdir(join(root, '.devloop'))
    return root
  }

  function reviewIn(root: string) {
    return { ...reviewInput(join(root, '.devloop', 'worktrees', 'd1')), workspaceRoot: root }
  }

  const PASS = `<devloop_result>{"version":1,"kind":"review","taskId":"d1","reviewedSha":"${'a'.repeat(40)}","verdict":"PASS"}</devloop_result>`

  it("carries claude's tokens and settled price out of one run", async () => {
    const root = await workspace()
    const runner: HeadlessRunner = async () => ({
      stdout: JSON.stringify({
        result: PASS,
        total_cost_usd: 0.25,
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      stderr: '',
    })
    const result = await new ClaudeCliBackend(runner).run(reviewIn(root))
    expect(result).toMatchObject({ status: 'started', tokens: 120, costUsd: 0.25 })
    expect(result.outcome).toMatchObject({ kind: 'review', verdict: 'PASS' })
  })

  it('bills both attempts when the envelope had to be repaired', async () => {
    // A run that had to be asked twice cost twice; charging once would let a
    // misbehaving model spend past the cap for free.
    const root = await workspace()
    let call = 0
    const runner: HeadlessRunner = async () => {
      call += 1
      return {
        stdout: JSON.stringify({
          result: call === 1 ? '<devloop_result>not json</devloop_result>' : PASS,
          total_cost_usd: 0.1,
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        stderr: '',
      }
    }
    const result = await new ClaudeCliBackend(runner).run(reviewIn(root))
    expect(call).toBe(2)
    expect(result).toMatchObject({ tokens: 22, costUsd: 0.2 })
  })

  it('reports codex tokens without inventing a price', async () => {
    const root = await workspace()
    const runner: HeadlessRunner = async () => ({
      stdout: [
        `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(PASS)}}}`,
        '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":5}}',
      ].join('\n'),
      stderr: '',
    })
    const result = await new CodexCliBackend(runner).run(reviewIn(root))
    expect(result.tokens).toBe(55)
    expect(result.costUsd).toBeUndefined()
    expect(result.outcome).toMatchObject({ verdict: 'PASS' })
  })

  it('writes the operator note as prose, not as the transport envelope', async () => {
    const root = await workspace()
    const runner: HeadlessRunner = async () => ({
      stdout: JSON.stringify({ result: 'A readable plan.', total_cost_usd: 0.01 }),
      stderr: '',
    })
    await new ClaudeCliBackend(runner).run({
      ...planInput(join(root, '.devloop', 'worktrees', '_loop-plan')),
      workspaceRoot: root,
    })
    const note = await readFile(join(root, '.devloop', 'PLAN.md'), 'utf8')
    expect(note).toContain('A readable plan.')
    expect(note).not.toContain('total_cost_usd')
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
      '--json',
      '--sandbox',
      'read-only',
      expect.stringContaining('Review task d1'),
    ])
    expect(calls[0]?.argv.at(-1)).toContain('Do not edit files')
    expect(calls[0]?.cwd).toBe('/repo/.devloop/worktrees/d1')
    expect(calls[0]?.timeoutMs).toBe(limits.taskTimeoutMinutes * 60_000)
  })

  it('uses workspace-write for delegate and asks for a commit', async () => {
    const calls: HeadlessRun[] = []
    const backend = new CodexCliBackend(fakeRunner(calls))
    await backend.run(delegateInput('/repo/.devloop/worktrees/d1'))
    expect(calls[0]?.argv).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      '/repo/.git/worktrees/d1',
      expect.stringContaining('Execute task d1'),
    ])
    expect(calls[0]?.argv.at(-1)).toContain('Do not run git')
  })

  it('downgrades a Codex delegate protocol repair to read-only without an added gitdir', async () => {
    const calls: HeadlessRun[] = []
    const valid = '<devloop_result>{"version":1,"kind":"implementation","taskId":"d1","outcome":"completed","summary":"done"}</devloop_result>'
    const backend = new CodexCliBackend(async request => {
      calls.push(request)
      return { stdout: calls.length === 1 ? '<devloop_result>{broken}</devloop_result>' : valid, stderr: '' }
    })
    await expect(backend.run(delegateInput('/repo/.devloop/worktrees/d1')))
      .resolves.toMatchObject({ status: 'started', outcome: { kind: 'implementation' } })
    expect(calls[0]?.argv).toContain('workspace-write')
    expect(calls[1]?.argv).toContain('read-only')
    expect(calls[1]?.argv).not.toContain('workspace-write')
    expect(calls[1]?.argv).not.toContain('--add-dir')
  })

  it('passes a routed model to Codex CLI', async () => {
    const calls: HeadlessRun[] = []
    const backend = new CodexCliBackend(fakeRunner(calls))
    await backend.run({
      ...reviewInput('/repo/.devloop/worktrees/d1'),
      route: { tier: 'T3', backend: 'codex', model: 'gpt-5.4' },
    })
    expect(calls[0]?.argv.slice(0, 6)).toEqual([
      'exec', '--json', '--sandbox', 'read-only', '--model', 'gpt-5.4',
    ])
    expect(calls[0]?.argv.at(-1)).toContain('Review task d1')
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
      '--json',
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
      '--json',
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
    expect(argv).toEqual(['exec', '--json', '--sandbox', 'read-only', headlessPrompt(input)])
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
