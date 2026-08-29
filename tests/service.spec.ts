import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RecordingBackend } from '../src/backend.ts'
import type { AgentBackend, AgentRunInput, AgentRunResult } from '../src/backend.ts'
import { ClaudeCliBackend } from '../src/cli.ts'
import type { HeadlessRun } from '../src/dsh.ts'
import { resolveConfig } from '../src/config.ts'
import { emptyState, loadState, saveState, withStateLock, workspaceArmed } from '../src/persist.ts'
import { contractForTask } from '../src/router.ts'
import DevloopService from '../src/service.ts'
import { planWorktreePath, prepareDelegateWorktree, readContractBaseSha, worktreePath } from '../src/worktree.ts'
import { initGitRepo, makeTask, mkdtempInRepo } from './helpers.ts'

async function waitForAction(root: string, type: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const state = await loadState(root, Date.now())
    if (state.lastAction.type === type) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const last = await loadState(root, Date.now())
  throw new Error(`timed out waiting for action ${type}, last=${last.lastAction.type}`)
}

async function waitForRuns(backend: RecordingBackend, n: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (backend.runs.length >= n) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${n} runs, have ${backend.runs.length}`)
}

async function armWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devloop-svc-'))
  await mkdir(join(root, '.devloop'))
  await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
  return root
}

class LockProbeBackend extends RecordingBackend {
  lockOk = false

  constructor(private readonly workspaceRoot: string) {
    super()
  }

  override async run(input: Parameters<RecordingBackend['run']>[0]) {
    const outcome = await withStateLock(this.workspaceRoot, async () => 'acquired')
    this.lockOk = outcome.ok
    return super.run(input)
  }
}

describe('DevloopService', () => {
  const services: DevloopService[] = []

  afterEach(() => {
    for (const service of services) service.stop()
    services.length = 0
  })

  it('stays idle when the workspace is not armed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-svc-'))
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }))
    services.push(service)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'idle' })
    expect(loaded.killSwitch).toBe(false)
  })

  it('records plan then stops rewriting after the first armed tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-svc-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }))
    services.push(service)
    await waitForAction(root, 'plan')
    const first = await loadState(root, Date.now())
    expect(first.lastAction).toEqual({ type: 'plan' })
    const updatedAt = first.updatedAt
    await service.tick()
    const second = await loadState(root, Date.now())
    expect(second.lastAction).toEqual({ type: 'plan' })
    expect(second.updatedAt).toBe(updatedAt)
  })

  it('hands plan to AgentBackend after STATE is written, once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-svc-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }), backend)
    services.push(service)
    await waitForAction(root, 'plan')
    await waitForRuns(backend, 1)
    expect(backend.runs).toHaveLength(1)
    expect(backend.runs[0]?.action).toEqual({ type: 'plan' })
    expect(backend.runs[0]?.workspaceRoot).toBe(root)
    expect(backend.runs[0]?.contract).toBeNull()
    await service.tick()
    expect(backend.runs).toHaveLength(1)
  })

  it('dispatches delegate with a frozen contract into a worktree', async () => {
    const root = await mkdtempInRepo('devloop-svc-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({
        id: 'd1',
        status: 'ready',
        title: 'Add persist',
        allowedPaths: ['src/persist.ts'],
      })],
    })
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }), backend)
    services.push(service)
    await waitForAction(root, 'delegate')
    await waitForRuns(backend, 1)
    expect(backend.runs[0]?.action).toEqual({ type: 'delegate', taskId: 'd1' })
    expect(backend.runs[0]?.contract?.taskId).toBe('d1')
    expect(backend.runs[0]?.contract?.forbidden).toContain('.devloop/')
    expect(backend.runs[0]?.worktreeRoot).toBe(join(root, '.devloop', 'worktrees', 'd1'))
    const raw = await readFile(join(root, '.devloop', 'worktrees', 'd1', '.devloop', 'CONTRACT.json'), 'utf8')
    expect(JSON.parse(raw).taskId).toBe('d1')
  })

  it('does not latch delegate when worktree prepare fails; retries after the repo is a git toplevel', async () => {
    const root = await armWorkspace()
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready' })],
    })
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), backend)
    services.push(service)
    await service.tick()
    const first = await loadState(root, Date.now())
    expect(first.lastAction).toEqual({ type: 'idle' })
    expect(backend.runs).toHaveLength(0)
    await initGitRepo(root)
    await service.tick()
    const second = await loadState(root, Date.now())
    expect(second.lastAction).toEqual({ type: 'delegate', taskId: 'd1' })
    expect(backend.runs).toHaveLength(1)
    expect(backend.runs[0]?.worktreeRoot).toBeTruthy()
  })

  it('dispatches review into an existing worktree, not the workspace root', async () => {
    const root = await mkdtempInRepo('devloop-svc-review-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    const dest = join(root, '.devloop', 'worktrees', 'd1')
    await mkdir(dest, { recursive: true })
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'review_pending', title: 'Add persist' })],
    })
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }), backend)
    services.push(service)
    await waitForAction(root, 'review')
    await waitForRuns(backend, 1)
    expect(backend.runs[0]?.action).toEqual({ type: 'review', taskId: 'd1' })
    expect(backend.runs[0]?.worktreeRoot).toBe(dest)
    expect(backend.runs[0]?.workspaceRoot).toBe(root)
  })

  it('does not dispatch merge to AgentBackend; without PASS it escalates', async () => {
    const root = await armWorkspace()
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'm1', status: 'merge_ready' })],
    })
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }), backend)
    services.push(service)
    await waitForAction(root, 'escalate')
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'escalate', taskId: 'm1', reason: 'no_review_pass' })
    expect(backend.runs).toHaveLength(0)
  })

  it('does not latch a failed git merge; retries after the worktree exists', async () => {
    const root = await mkdtempInRepo('devloop-svc-merge-fail-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'm1', status: 'merge_ready', lastReviewVerdict: 'PASS' })],
    })
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), backend)
    services.push(service)
    await service.tick()
    const first = await loadState(root, Date.now())
    expect(first.lastAction).toEqual({ type: 'merge', taskId: 'm1' })
    expect(first.tasks[0]?.status).toBe('merge_ready')
    expect(backend.runs).toHaveLength(0)

    const limits = resolveConfig({}).budget
    const dest = await prepareDelegateWorktree(root, contractForTask(
      'm1',
      'Add persist',
      'T1',
      ['src/**'],
      ['tests pass'],
      limits.taskTimeoutMinutes,
      limits.maxTaskAttempts,
    ))
    const baseSha = await readContractBaseSha(dest)
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/)
    await saveState(root, {
      ...first,
      tasks: [{ ...first.tasks[0]!, baseSha: baseSha! }],
    })
    await writeFile(join(dest, 'src.txt'), 'merged\n', 'utf8')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])

    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'merge', taskId: 'm1' })
    expect(loaded.tasks[0]?.status).toBe('done')
    expect(backend.runs).toHaveLength(0)
    await expect(readFile(join(root, 'src.txt'), 'utf8')).resolves.toBe('merged\n')
    await expect(execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/devloop/m1'])).rejects.toThrow()
  }, 30_000)

  it('git-merges PASS work, deletes the worktree, and does not call AgentBackend', async () => {
    const root = await mkdtempInRepo('devloop-svc-merge-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    const limits = resolveConfig({}).budget
    const dest = await prepareDelegateWorktree(root, contractForTask(
      'm1',
      'Add persist',
      'T1',
      ['src/**'],
      ['tests pass'],
      limits.taskTimeoutMinutes,
      limits.maxTaskAttempts,
    ))
    await writeFile(join(dest, 'src.txt'), 'landed\n', 'utf8')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({
        id: 'm1',
        status: 'merge_ready',
        lastReviewVerdict: 'PASS_WITH_NOTES',
        baseSha: (await readContractBaseSha(dest)) ?? undefined,
      })],
    })
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), backend)
    services.push(service)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.tasks[0]?.status).toBe('done')
    expect(backend.runs).toHaveLength(0)
    await expect(readFile(join(root, 'src.txt'), 'utf8')).resolves.toBe('landed\n')
    await expect(readFile(join(dest, 'src.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/devloop/m1'])).rejects.toThrow()
  })

  it('escalates an empty PASS task instead of marking it done', async () => {
    const root = await mkdtempInRepo('devloop-svc-empty-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    const limits = resolveConfig({}).budget
    const dest = await prepareDelegateWorktree(root, contractForTask(
      'm1',
      'Add persist',
      'T1',
      ['src/**'],
      ['tests pass'],
      limits.taskTimeoutMinutes,
      limits.maxTaskAttempts,
    ))
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({
        id: 'm1',
        status: 'merge_ready',
        lastReviewVerdict: 'PASS',
        baseSha: (await readContractBaseSha(dest)) ?? undefined,
      })],
    })
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), backend)
    services.push(service)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'escalate', taskId: 'm1', reason: 'empty_task' })
    expect(loaded.tasks[0]?.status).toBe('merge_ready')
    expect(loaded.supervisor).toEqual({ taskId: 'm1', reason: 'empty_task' })
    expect((await lstat(dest)).isDirectory()).toBe(true)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/devloop/m1'])
  })

  it('escalates an empty PASS task after the worktree is gone', async () => {
    const root = await mkdtempInRepo('devloop-svc-empty-gone-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    const limits = resolveConfig({}).budget
    const dest = await prepareDelegateWorktree(root, contractForTask(
      'm1',
      'Add persist',
      'T1',
      ['src/**'],
      ['tests pass'],
      limits.taskTimeoutMinutes,
      limits.maxTaskAttempts,
    ))
    const baseSha = await readContractBaseSha(dest)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'm1', status: 'merge_ready', lastReviewVerdict: 'PASS', baseSha: baseSha ?? undefined })],
    })
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    await execFileAsync('git', ['-C', root, 'worktree', 'remove', dest])
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), backend)
    services.push(service)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'escalate', taskId: 'm1', reason: 'empty_task' })
    expect(loaded.tasks[0]?.status).toBe('merge_ready')
    await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/devloop/m1'])
  })

  it('escalates an empty PASS task when CONTRACT.json is missing', async () => {
    const root = await mkdtempInRepo('devloop-svc-empty-nocontract-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    const limits = resolveConfig({}).budget
    const dest = await prepareDelegateWorktree(root, contractForTask(
      'm1',
      'Add persist',
      'T1',
      ['src/**'],
      ['tests pass'],
      limits.taskTimeoutMinutes,
      limits.maxTaskAttempts,
    ))
    const baseSha = await readContractBaseSha(dest)
    await rm(join(dest, '.devloop', 'CONTRACT.json'))
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'm1', status: 'merge_ready', lastReviewVerdict: 'PASS', baseSha: baseSha ?? undefined })],
    })
    const backend = new RecordingBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), backend)
    services.push(service)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'escalate', taskId: 'm1', reason: 'empty_task' })
    expect(loaded.tasks[0]?.status).toBe('merge_ready')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/devloop/m1'])
  }, 30_000)

  it('does not retry after a throwing backend; STATE stays latched', async () => {
    const root = await armWorkspace()
    const backend: AgentBackend & { calls: number } = {
      calls: 0,
      async run(_input: AgentRunInput): Promise<AgentRunResult> {
        this.calls += 1
        throw new Error('boom')
      },
      async cancel() {},
      async health() { return 'ok' },
    }
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }), backend)
    services.push(service)
    await waitForAction(root, 'plan')
    const start = Date.now()
    while (backend.calls < 1 && Date.now() - start < 2000) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(backend.calls).toBe(1)
    await service.tick()
    expect(backend.calls).toBe(1)
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'plan' })
    expect(loaded.killSwitch).toBe(false)
  })

  it('releases the STATE lock before AgentBackend.run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-svc-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    const backend = new LockProbeBackend(root)
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }), backend)
    services.push(service)
    await waitForAction(root, 'plan')
    await waitForRuns(backend, 1)
    expect(backend.lockOk).toBe(true)
    expect(backend.runs).toHaveLength(1)
  })

  it('does not start when disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-svc-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    expect(await workspaceArmed(root)).toBe(true)
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, enabled: false }))
    services.push(service)
    await new Promise(resolve => setTimeout(resolve, 50))
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'idle' })
  })

  it('aborts a hung backend after taskTimeoutMinutes and unsticks busy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const root = await armWorkspace()
      let seen: AbortSignal | undefined
      let calls = 0
      const hung: AgentBackend = {
        async run(input) {
          calls += 1
          seen = input.signal
          if (calls === 1) await new Promise(() => {})
          return { status: 'recorded' }
        },
        async cancel() {},
        async health() { return 'ok' },
      }
      const ctx = new Context()
      const service = new DevloopService(ctx, resolveConfig({
        root,
        enabled: false,
        budget: { taskTimeoutMinutes: 1 },
      }), hung)
      services.push(service)
      const first = service.tick()
      const start = Date.now()
      while (seen === undefined && Date.now() - start < 2000) {
        await new Promise(resolve => setImmediate(resolve))
      }
      expect(seen).toBeDefined()
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.advanceTimersByTimeAsync(4_250)
      await first
      expect(seen?.aborted).toBe(true)
      expect(calls).toBe(1)
      await saveState(root, {
        ...await loadState(root, Date.now()),
        tasks: [makeTask({ id: 'd1', status: 'review_pending' })],
      })
      await service.tick()
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs T3 plan inside a reserved worktree, not the workspace root', async () => {
    const root = await mkdtempInRepo('devloop-svc-plan-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    const calls: HeadlessRun[] = []
    const backend = new ClaudeCliBackend(async request => {
      calls.push(request)
      await expect(readFile(join(request.cwd, '.devloop', 'GOAL.md'), 'utf8')).resolves.toBe('# Goal\n')
      return { stdout: '', stderr: '' }
    })
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
      agentBackend: 'claude',
    }), backend)
    services.push(service)
    await service.tick()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cwd).toBe(planWorktreePath(root))
    expect(calls[0]?.argv).toEqual([
      '-p',
      '--permission-mode',
      'plan',
      expect.stringContaining('GOAL.md'),
    ])
    await expect(lstat(planWorktreePath(root))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
