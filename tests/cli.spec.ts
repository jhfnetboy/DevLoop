import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { NoopBackend, RecordingBackend, runInputFor } from '../src/backend.ts'
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

describe('ClaudeCliBackend', () => {
  it('runs claude -p in the worktree without a shell', async () => {
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(fakeRunner(calls))
    const input = {
      ...runInputFor(
        '/repo',
        { type: 'review', taskId: 'd1' },
        baseState({ tasks: [makeTask({ id: 'd1', status: 'review_pending', title: 'Add persist' })] }),
        limits,
      ),
      worktreeRoot: '/repo/.devloop/worktrees/d1',
    }
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    expect(calls[0]?.command).toBe('claude')
    expect(calls[0]?.argv).toEqual(['-p', expect.stringContaining('Review task d1')])
    expect(calls[0]?.cwd).toBe('/repo/.devloop/worktrees/d1')
  })

  it('passes -p and the prompt as two execFile argv entries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-claude-argv-'))
    const command = fileURLToPath(new URL('./fixtures/echo-argv.mjs', import.meta.url))
    await chmod(command, 0o755)
    const backend = new ClaudeCliBackend(undefined, command)
    const input = {
      ...runInputFor('/repo', { type: 'plan' }, baseState(), limits),
      workspaceRoot: cwd,
      worktreeRoot: null,
    }
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    const argv = JSON.parse(await readFile(join(cwd, 'argv.json'), 'utf8')) as string[]
    expect(argv).toEqual(['-p', headlessPrompt(input)])
  })

  it('returns failed when the runner throws', async () => {
    const backend = new ClaudeCliBackend(async () => {
      throw new Error('spawn ENOENT')
    })
    const input = runInputFor('/repo', { type: 'plan' }, baseState(), limits)
    await expect(backend.run(input)).resolves.toEqual({
      status: 'failed',
      detail: 'spawn ENOENT',
    })
  })

  it('forwards AbortSignal to the runner', async () => {
    const abort = new AbortController()
    let seen: AbortSignal | undefined
    const backend = new ClaudeCliBackend(async request => {
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
    const ok = new ClaudeCliBackend(fakeRunner([]))
    await expect(ok.health()).resolves.toBe('ok')
    const down = new ClaudeCliBackend(async () => {
      throw new Error('missing')
    })
    await expect(down.health()).resolves.toBe('down')
  })
})

describe('CodexCliBackend', () => {
  it('runs codex exec in the worktree without a shell', async () => {
    const calls: HeadlessRun[] = []
    const backend = new CodexCliBackend(fakeRunner(calls))
    const input = {
      ...runInputFor(
        '/repo',
        { type: 'plan' },
        baseState(),
        limits,
      ),
      worktreeRoot: null,
    }
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    expect(calls[0]?.command).toBe('codex')
    expect(calls[0]?.argv).toEqual(['exec', expect.stringContaining('GOAL.md')])
    expect(calls[0]?.cwd).toBe('/repo')
  })

  it('passes exec and the prompt as two execFile argv entries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-codex-argv-'))
    const command = fileURLToPath(new URL('./fixtures/echo-argv.mjs', import.meta.url))
    await chmod(command, 0o755)
    const backend = new CodexCliBackend(undefined, command)
    const input = {
      ...runInputFor('/repo', { type: 'plan' }, baseState(), limits),
      workspaceRoot: cwd,
      worktreeRoot: null,
    }
    await expect(backend.run(input)).resolves.toEqual({ status: 'started' })
    const argv = JSON.parse(await readFile(join(cwd, 'argv.json'), 'utf8')) as string[]
    expect(argv).toEqual(['exec', headlessPrompt(input)])
  })

  it('returns failed when the runner throws', async () => {
    const backend = new CodexCliBackend(async () => {
      throw new Error('spawn ENOENT')
    })
    const input = runInputFor('/repo', { type: 'plan' }, baseState(), limits)
    await expect(backend.run(input)).resolves.toEqual({
      status: 'failed',
      detail: 'spawn ENOENT',
    })
  })
})

describe('createBackend T3 CLIs', () => {
  it('keeps NoopBackend when agentBackend is omitted', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root: '/tmp', enabled: false }))
    expect(service.backend).toBeInstanceOf(NoopBackend)
    expect(service.backend).not.toBeInstanceOf(RecordingBackend)
  })

  it('returns ClaudeCliBackend when cordis passes agentBackend=claude', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root: '/tmp',
      enabled: false,
      agentBackend: 'claude',
    }))
    expect(service.backend).toBeInstanceOf(ClaudeCliBackend)
    expect(service.backend).not.toBeInstanceOf(RecordingBackend)
  })

  it('returns CodexCliBackend when cordis passes agentBackend=codex', () => {
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root: '/tmp',
      enabled: false,
      agentBackend: 'codex',
    }))
    expect(service.backend).toBeInstanceOf(CodexCliBackend)
    expect(service.backend).not.toBeInstanceOf(RecordingBackend)
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
