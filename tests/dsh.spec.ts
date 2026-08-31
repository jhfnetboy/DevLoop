import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { runInputFor } from '../src/backend.ts'
import type { HeadlessRun } from '../src/dsh.ts'
import { DshHeadlessBackend, headlessPrompt } from '../src/dsh.ts'
import { resolveConfig } from '../src/config.ts'
import DevloopService from '../src/service.ts'
import { NoopBackend, RoutedBackend } from '../src/backend.ts'
import { baseState, makeTask } from './helpers.ts'

const limits = resolveConfig({}).budget

function fakeRunner(calls: HeadlessRun[]) {
  return async (request: HeadlessRun) => {
    calls.push(request)
    return { stdout: '', stderr: '' }
  }
}

describe('DshHeadlessBackend', () => {
  it('runs dsh --profile headless in the worktree without a shell', async () => {
    const calls: HeadlessRun[] = []
    const backend = new DshHeadlessBackend(fakeRunner(calls))
    const input = {
      ...runInputFor(
        '/repo',
        { type: 'delegate', taskId: 'd1' },
        baseState({ tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })] }),
        limits,
      ),
      worktreeRoot: '/repo/.devloop/worktrees/d1',
    }
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    expect(calls[0]?.argv).toEqual(['--profile', 'headless', expect.stringContaining('Execute task d1')])
    expect(calls[0]?.timeoutMs).toBe(limits.taskTimeoutMinutes * 60_000)
    expect(calls[0]?.cwd).toBe('/repo/.devloop/worktrees/d1')
  })

  it('passes --profile, headless, and the prompt as three execFile argv entries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-dsh-argv-'))
    const command = fileURLToPath(new URL('./fixtures/echo-argv.mjs', import.meta.url))
    await chmod(command, 0o755)
    const backend = new DshHeadlessBackend(undefined, command)
    const input = {
      ...runInputFor('/repo', { type: 'plan' }, baseState(), limits),
      workspaceRoot: cwd,
      worktreeRoot: null,
    }
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    const argv = JSON.parse(await readFile(join(cwd, 'argv.json'), 'utf8')) as string[]
    expect(argv).toEqual(['--profile', 'headless', headlessPrompt(input)])
  })

  it('uses workspaceRoot when there is no worktree (plan)', async () => {
    const calls: HeadlessRun[] = []
    const backend = new DshHeadlessBackend(fakeRunner(calls))
    const input = runInputFor('/repo', { type: 'plan' }, baseState(), limits)
    await backend.run(input)
    expect(calls[0]?.cwd).toBe('/repo')
    expect(headlessPrompt(input)).toContain('GOAL.md')
  })

  it('pins the routed DeepSeek model with an isolated DSH patch', async () => {
    let patch = ''
    const backend = new DshHeadlessBackend(async request => {
      const patchIndex = request.argv.indexOf('--patch')
      expect(patchIndex).toBeGreaterThan(0)
      patch = await readFile(request.argv[patchIndex + 1]!, 'utf8')
      return { stdout: '', stderr: '' }
    })
    const input = {
      ...runInputFor('/repo', { type: 'plan' }, baseState(), limits),
      route: { tier: 'T2' as const, backend: 'dsh', model: 'deepseek-v4-pro' },
    }
    await expect(backend.run(input)).resolves.toEqual({
      status: 'started',
      agent: 'dsh/deepseek-v4-pro',
    })
    expect(patch).toContain('provider: deepseek-official')
    expect(patch).toContain('model: "deepseek-v4-pro"')
  })

  it('returns failed when the runner throws', async () => {
    const backend = new DshHeadlessBackend(async () => {
      throw new Error('spawn ENOENT')
    })
    const input = runInputFor('/repo', { type: 'plan' }, baseState(), limits)
    await expect(backend.run(input)).resolves.toEqual({
      status: 'failed',
      detail: 'spawn ENOENT',
    })
  })

  it('retries one malformed result without asking for more edits', async () => {
    const calls: HeadlessRun[] = []
    const valid = '<devloop_result>{"version":1,"kind":"plan","tasks":[{"id":"d1","title":"One","tier":"T1","risk":"low","allowedPaths":["hello.txt"],"acceptance":["exists"]}]}</devloop_result>'
    const backend = new DshHeadlessBackend(async request => {
      calls.push(request)
      return { stdout: calls.length === 1 ? '<devloop_result>{broken}</devloop_result>' : valid, stderr: '' }
    })
    const result = await backend.run(runInputFor('/repo', { type: 'plan' }, baseState(), limits))
    expect(result).toMatchObject({ status: 'started', outcome: { kind: 'plan' } })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.argv.at(-1)).toContain('Do not make additional edits')
  })

  it('forwards AbortSignal to the runner', async () => {
    const abort = new AbortController()
    let seen: AbortSignal | undefined
    const backend = new DshHeadlessBackend(async request => {
      seen = request.signal
      return { stdout: '', stderr: '' }
    })
    await backend.run({
      ...runInputFor('/repo', { type: 'plan' }, baseState(), limits),
      signal: abort.signal,
    })
    expect(seen).toBe(abort.signal)
  })

  it('reports health from a help probe', async () => {
    const ok = new DshHeadlessBackend(fakeRunner([]))
    await expect(ok.health()).resolves.toBe('ok')
    const down = new DshHeadlessBackend(async () => {
      throw new Error('missing')
    })
    await expect(down.health()).resolves.toBe('down')
  })
})

describe('createBackend from config', () => {
  it('keeps NoopBackend when agentBackend is omitted', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root: '/tmp', enabled: false }))
    expect(service.backend).toBeInstanceOf(NoopBackend)
  })

  it('returns DshHeadlessBackend when cordis passes agentBackend=dsh', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root: '/tmp',
      enabled: false,
      agentBackend: 'dsh',
    }))
    expect(service.backend).toBeInstanceOf(DshHeadlessBackend)
  })

  it('returns RoutedBackend when cordis passes agentBackend=routed', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root: '/tmp',
      enabled: false,
      agentBackend: 'routed',
    }))
    expect(service.backend).toBeInstanceOf(RoutedBackend)
  })
})
