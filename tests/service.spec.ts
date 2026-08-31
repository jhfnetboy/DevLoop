import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RecordingBackend } from '../src/backend.ts'
import type { AgentBackend, AgentRunInput, AgentRunResult } from '../src/backend.ts'
import { ClaudeCliBackend } from '../src/cli.ts'
import type { HeadlessRun } from '../src/dsh.ts'
import { resolveConfig } from '../src/config.ts'
import { emptyUsage } from '../src/budget.ts'
import { emptyState, loadState, saveState, statePath, withStateLock, workspaceArmed } from '../src/persist.ts'
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

  it('writes PROGRESS.md after a plan tick and refreshes it on the latched follow-up', async () => {
    const root = await armWorkspace()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }))
    services.push(service)
    await service.tick()
    const first = await readFile(join(root, '.devloop', 'PROGRESS.md'), 'utf8')
    expect(first).toContain('# DevLoop progress')
    expect(first).toContain('lastAction: plan')
    await new Promise(resolve => setTimeout(resolve, 5))
    await service.tick()
    const second = await readFile(join(root, '.devloop', 'PROGRESS.md'), 'utf8')
    expect(second).toContain('lastAction: plan')
    const firstUpdated = /Updated: (.+)/.exec(first)?.[1]
    const secondUpdated = /Updated: (.+)/.exec(second)?.[1]
    expect(secondUpdated).not.toBe(firstUpdated)
  })

  it('overwrites PROGRESS.md on a killSwitch tick', async () => {
    const root = await armWorkspace()
    const now = Date.now()
    await saveState(root, { ...emptyState(now), killSwitch: true })
    await writeFile(join(root, '.devloop', 'PROGRESS.md'), '- killSwitch: false\n', 'utf8')
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }))
    services.push(service)
    await service.tick()
    const progress = await readFile(join(root, '.devloop', 'PROGRESS.md'), 'utf8')
    expect(progress).toContain('killSwitch: true')
    expect(progress).not.toContain('killSwitch: false')
  })

  it('folds backend cost and tokens into STATE after dispatch', async () => {
    const root = await mkdtempInRepo('devloop-svc-cost-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })],
    })
    class CostBackend extends RecordingBackend {
      override async run(input: Parameters<RecordingBackend['run']>[0]) {
        await super.run(input)
        return { status: 'recorded' as const, tokens: 12, costUsd: 0.4 }
      }
    }
    const backend = new CostBackend()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), backend)
    services.push(service)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.usage.tokens.d1).toBe(12)
    expect(loaded.usage.costUsdSession).toBe(0.4)
    expect(loaded.tasks.map(task => task.id)).toEqual(['d1'])
    expect(loaded.lastAction).toEqual({ type: 'delegate', taskId: 'd1' })
    expect(loaded.killSwitch).toBe(false)
    expect(loaded.supervisor).toBeNull()
    const md = await readFile(join(root, '.devloop', 'PROGRESS.md'), 'utf8')
    expect(md).toContain('costUsdSession: 0.4')
  })

  it('zeros leftover session cost once and does not re-zero in-session spend', async () => {
    const root = await mkdtempInRepo('devloop-svc-session-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    const now = Date.now()
    await saveState(root, {
      ...emptyState(now),
      usage: { ...emptyUsage(now), costUsdSession: 5, costUsdDay: 9, lastProgressAt: now },
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })],
    })
    class CostBackend extends RecordingBackend {
      override async run(input: Parameters<RecordingBackend['run']>[0]) {
        await super.run(input)
        return { status: 'recorded' as const, tokens: 12, costUsd: 0.4 }
      }
    }
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), new CostBackend())
    services.push(service)
    await service.tick()
    let loaded = await loadState(root, Date.now())
    expect(loaded.usage.costUsdSession).toBe(0.4)
    expect(loaded.usage.costUsdDay).toBe(9.4)
    expect(loaded.tasks.map(task => task.id)).toEqual(['d1'])
    expect(loaded.killSwitch).toBe(false)
    expect(loaded.supervisor).toBeNull()
    await service.tick()
    loaded = await loadState(root, Date.now())
    expect(loaded.usage.costUsdSession).toBe(0.4)
  })

  it('defers cost signals when the fold lock is held and applies them next tick', async () => {
    const root = await mkdtempInRepo('devloop-svc-cost-defer-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })],
    })
    class DeferBackend extends RecordingBackend {
      releaseLock!: () => void
      override async run(input: Parameters<RecordingBackend['run']>[0]) {
        await super.run(input)
        const held = new Promise<void>(resolve => {
          this.releaseLock = resolve
        })
        const acquired = new Promise<void>(resolve => {
          void withStateLock(root, async () => {
            resolve()
            await held
          })
        })
        await acquired
        return { status: 'recorded' as const, tokens: 12, costUsd: 0.4 }
      }
    }
    const ctx = new Context()
    const backend = new DeferBackend()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), backend)
    services.push(service)
    await service.tick()
    let loaded = await loadState(root, Date.now())
    expect(loaded.usage.costUsdSession).toBe(0)
    backend.releaseLock()
    await new Promise(resolve => setTimeout(resolve, 20))
    await service.tick()
    loaded = await loadState(root, Date.now())
    expect(loaded.usage.costUsdSession).toBe(0.4)
    expect(loaded.usage.tokens.d1).toBe(12)
  })

  it('persists UTC daily cost rollover on a latched skipped tick', async () => {
    const root = await armWorkspace()
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }))
    services.push(service)
    const day1 = Date.UTC(2020, 0, 1, 12)
    await service.tick(day1)
    const afterPlan = await loadState(root, day1)
    expect(afterPlan.lastAction).toEqual({ type: 'plan' })
    await saveState(root, {
      ...afterPlan,
      usage: {
        ...afterPlan.usage,
        costUsdDay: 9,
        lastProgressAt: Date.UTC(2020, 0, 1, 23, 59, 0),
      },
    })
    const justAfterMidnight = Date.UTC(2020, 0, 2, 0, 0, 30)
    await service.tick(justAfterMidnight)
    const loaded = await loadState(root, justAfterMidnight)
    expect(loaded.lastAction).toEqual({ type: 'plan' })
    expect(loaded.usage.costUsdDay).toBe(0)
  })

  it('still zeros session cost after an unreadable first tick', async () => {
    const root = await mkdtempInRepo('devloop-svc-unread-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    const now = Date.now()
    const unreadState = {
      ...emptyState(now),
      usage: { ...emptyUsage(now), costUsdSession: 5, lastProgressAt: now },
    }
    await saveState(root, unreadState)
    await writeFile(join(root, '.devloop', 'PROGRESS.md'), [
      '# DevLoop progress',
      '',
      '- costUsdDay: 12',
      '- tasks: 1 (ready 1)',
      '',
      '## Tasks',
      '',
      '- t-1 ready Real work',
      '',
    ].join('\n'))
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }))
    services.push(service)
    await chmod(statePath(root), 0)
    await service.tick()
    await chmod(statePath(root), 0o644)
    const unread = await loadState(root, Date.now())
    expect(unread.usage.costUsdSession).toBe(5)
    expect(unread.lastAction).toEqual({ type: 'idle' })
    expect(unread.supervisor).toBeNull()
    const afterUnread = await readFile(join(root, '.devloop', 'PROGRESS.md'), 'utf8')
    expect(afterUnread).toContain('- t-1')
    expect(afterUnread).toContain('costUsdDay: 12')
    expect(afterUnread).not.toContain('unreadable_state')
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.usage.costUsdSession).toBe(0)
    expect(loaded.lastAction).toEqual({ type: 'plan' })
  })

  it('does not fold cost into STATE that tripped killSwitch during dispatch', async () => {
    const root = await mkdtempInRepo('devloop-svc-fold-kill-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })],
    })
    class FlipBackend extends RecordingBackend {
      override async run(input: Parameters<RecordingBackend['run']>[0]) {
        await super.run(input)
        const current = await loadState(root, Date.now())
        await saveState(root, { ...current, killSwitch: true })
        return { status: 'recorded' as const, tokens: 12, costUsd: 0.4 }
      }
    }
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), new FlipBackend())
    services.push(service)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.usage.costUsdSession).toBe(0)
    expect(loaded.usage.tokens.d1).toBeUndefined()
  })

  it('stops on the next tick after folded cost exceeds the session cap', async () => {
    const root = await mkdtempInRepo('devloop-svc-cap-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })],
    })
    class CostBackend extends RecordingBackend {
      override async run(input: Parameters<RecordingBackend['run']>[0]) {
        await super.run(input)
        return { status: 'recorded' as const, costUsd: 0.4 }
      }
    }
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
      budget: { maxCostUsdPerSession: 0.3 },
    }), new CostBackend())
    services.push(service)
    await service.tick()
    expect((await loadState(root, Date.now())).usage.costUsdSession).toBe(0.4)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.killSwitch).toBe(true)
    expect(loaded.lastAction).toEqual({ type: 'stop', reason: 'budget' })
  })

  it('defers cost signals when the fold write fails and applies them next tick', async () => {
    const root = await mkdtempInRepo('devloop-svc-cost-io-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })],
    })
    class WriteFailBackend extends RecordingBackend {
      override async run(input: Parameters<RecordingBackend['run']>[0]) {
        await super.run(input)
        await chmod(join(root, '.devloop'), 0o500)
        return { status: 'recorded' as const, tokens: 12, costUsd: 0.4 }
      }
    }
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), new WriteFailBackend())
    services.push(service)
    await service.tick()
    await chmod(join(root, '.devloop'), 0o755)
    let loaded = await loadState(root, Date.now())
    expect(loaded.usage.costUsdSession).toBe(0)
    await service.tick()
    loaded = await loadState(root, Date.now())
    expect(loaded.usage.costUsdSession).toBe(0.4)
    expect(loaded.usage.tokens.d1).toBe(12)
  })

  it('holds the task when the host commit fails after a started delegate', async () => {
    const root = await mkdtempInRepo('devloop-svc-commit-hold-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })],
    })
    class DirtyStartedBackend implements AgentBackend {
      async run(input: AgentRunInput): Promise<AgentRunResult> {
        if (!input.worktreeRoot) throw new Error('missing worktree')
        await writeFile(join(input.worktreeRoot, 'src.txt'), 'worker\n', 'utf8')
        const marker = await readFile(join(input.worktreeRoot, '.git'), 'utf8')
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(marker)
        if (!match?.[1]) throw new Error('missing gitdir')
        const gitDir = isAbsolute(match[1]) ? match[1] : join(input.worktreeRoot, match[1])
        await writeFile(join(gitDir, 'index.lock'), '', 'utf8')
        return { status: 'started' }
      }
      async cancel() {}
      async health() { return 'ok' }
    }
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), new DirtyStartedBackend())
    services.push(service)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.supervisor).toEqual({ taskId: 'd1', reason: 'parent_commit_failed' })
    expect(loaded.lastAction).toEqual({ type: 'escalate', taskId: 'd1', reason: 'parent_commit_failed' })
  })

  it('defers a parent-commit hold when LOCK is busy and persists it next tick', async () => {
    const root = await mkdtempInRepo('devloop-svc-commit-hold-defer-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initGitRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist' })],
    })
    const holdVictim = join(root, 'hold-victim.txt')
    await writeFile(holdVictim, 'keep\n', 'utf8')
    await symlink(holdVictim, join(root, '.devloop', 'COMMIT_HOLD'))
    class DirtyLockedBackend implements AgentBackend {
      releaseLock!: () => void
      async run(input: AgentRunInput): Promise<AgentRunResult> {
        if (!input.worktreeRoot) throw new Error('missing worktree')
        await writeFile(join(input.worktreeRoot, 'src.txt'), 'worker\n', 'utf8')
        const marker = await readFile(join(input.worktreeRoot, '.git'), 'utf8')
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(marker)
        if (!match?.[1]) throw new Error('missing gitdir')
        const gitDir = isAbsolute(match[1]) ? match[1] : join(input.worktreeRoot, match[1])
        await writeFile(join(gitDir, 'index.lock'), '', 'utf8')
        const held = new Promise<void>(resolve => {
          this.releaseLock = resolve
        })
        const acquired = new Promise<void>(resolve => {
          void withStateLock(root, async () => {
            resolve()
            await held
          })
        })
        await acquired
        return { status: 'started' }
      }
      async cancel() {}
      async health() { return 'ok' }
    }
    const ctx = new Context()
    const backend = new DirtyLockedBackend()
    const service = new DevloopService(ctx, resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }), backend)
    services.push(service)
    await service.tick()
    let loaded = await loadState(root, Date.now())
    expect(loaded.supervisor).toBeNull()
    expect(loaded.lastAction).toEqual({ type: 'delegate', taskId: 'd1' })
    await expect(readFile(join(root, '.devloop', 'COMMIT_HOLD'), 'utf8')).resolves.toBe('d1\n')
    await expect(readFile(holdVictim, 'utf8')).resolves.toBe('keep\n')
    expect((await lstat(join(root, '.devloop', 'COMMIT_HOLD'))).isSymbolicLink()).toBe(false)
    backend.releaseLock()
    await new Promise(resolve => setTimeout(resolve, 20))
    const restarted = new DevloopService(new Context(), resolveConfig({
      root,
      tickIntervalMs: 60_000,
      enabled: false,
    }))
    services.push(restarted)
    await restarted.tick()
    loaded = await loadState(root, Date.now())
    expect(loaded.supervisor).toEqual({ taskId: 'd1', reason: 'parent_commit_failed' })
  })
})
