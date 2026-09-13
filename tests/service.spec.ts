import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
import { gateFor } from '../src/gate.ts'
import { resumeLoop } from '../src/operator.ts'
import { emptyState, loadState, saveState, statePath, withStateLock, workspaceArmed } from '../src/persist.ts'
import { contractForTask } from '../src/router.ts'
import type { Task } from '../src/types.ts'
import DevloopService, { forgeMergers, persistAgentHold, persistAgentTransition } from '../src/service.ts'
import { readPrLog } from '../src/prlog.ts'
import { planWorktreePath, prepareDelegateWorktree, readContractBaseSha, taskWorktreeHeadSha, worktreePath } from '../src/worktree.ts'
import { initGitRepo, initWorkRepo, makeTask, mkdtempInRepo } from './helpers.ts'

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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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
    const beforeMerge = await loadState(root, Date.now())
    const implementationSha = await taskWorktreeHeadSha(dest)
    await saveState(root, {
      ...beforeMerge,
      tasks: beforeMerge.tasks.map(task => task.id === 'm1'
        ? { ...task, implementationSha }
        : task),
    })

    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'merge', taskId: 'm1' })
    expect(loaded.tasks[0]?.status).toBe('done')
    expect(backend.runs).toHaveLength(0)
    await expect(readFile(join(root, 'src.txt'), 'utf8')).resolves.toBe('merged\n')
    await expect(execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/devloop/m1'])).rejects.toThrow()
  }, 30_000)

  it('holds instead of merging when the checkout was switched back to the trunk, and merges once it is moved back', async () => {
    const root = await mkdtempInRepo('devloop-svc-trunk-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initWorkRepo(root)
    const limits = resolveConfig({}).budget
    const dest = await prepareDelegateWorktree(root, contractForTask(
      't1', 'Add persist', 'T1', ['src/**'], ['tests pass'], limits.taskTimeoutMinutes, limits.maxTaskAttempts,
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
        id: 't1',
        status: 'merge_ready',
        lastReviewVerdict: 'PASS',
        baseSha: (await readContractBaseSha(dest)) ?? undefined,
        implementationSha: await taskWorktreeHeadSha(dest),
      })],
    })
    // Started on a work branch, then someone switched the checkout back.
    await execFileAsync('git', ['-C', root, 'switch', '-q', 'main'])
    const mainBefore = (await execFileAsync('git', ['-C', root, 'rev-parse', 'main'])).stdout.trim()

    const backend = new RecordingBackend()
    const service = new DevloopService(new Context(), resolveConfig({ root, tickIntervalMs: 60_000, enabled: false }), backend)
    services.push(service)
    await service.tick()
    const held = await loadState(root, Date.now())
    expect(held.supervisor).toEqual({ taskId: 't1', reason: 'merge_onto_trunk' })
    expect(held.tasks[0]?.status).toBe('merge_ready')
    expect((await execFileAsync('git', ['-C', root, 'rev-parse', 'main'])).stdout.trim()).toBe(mainBefore)
    await expect(readFile(join(root, 'src.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(gateFor(held, limits, Date.now())?.question).toMatch(/trunk/)

    // The answer the gate gives: move the checkout back, then resume.
    await execFileAsync('git', ['-C', root, 'switch', '-q', 'work'])
    await resumeLoop(root, {}, limits, { via: 'dashboard', expectedRevision: held.revision, now: Date.now })
    await service.tick()
    expect((await loadState(root, Date.now())).tasks[0]?.status).toBe('done')
    await expect(readFile(join(root, 'src.txt'), 'utf8')).resolves.toBe('landed\n')
    expect((await execFileAsync('git', ['-C', root, 'rev-parse', 'main'])).stdout.trim()).toBe(mainBefore)
    // Merged without being redone: no model was called at any point.
    expect(backend.runs).toHaveLength(0)
  })

  it('holds on a trunk spelled in another case, where the filesystem makes them one ref', async (context) => {
    const root = await mkdtempInRepo('devloop-svc-trunk-case-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initWorkRepo(root)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    // Only meaningful where `Main` resolves to the loose `main` ref (macOS by default).
    if ((await execFileAsync('git', ['-C', root, 'switch', '-q', 'Main']).then(() => true, () => false)) === false) context.skip()
    await execFileAsync('git', ['-C', root, 'switch', '-q', 'work'])
    const limits = resolveConfig({}).budget
    const dest = await prepareDelegateWorktree(root, contractForTask(
      't1', 'Add persist', 'T1', ['src/**'], ['tests pass'], limits.taskTimeoutMinutes, limits.maxTaskAttempts,
    ))
    await writeFile(join(dest, 'src.txt'), 'landed\n', 'utf8')
    await execFileAsync('git', ['-C', dest, 'add', 'src.txt'])
    await execFileAsync('git', ['-C', dest, 'commit', '-m', 'worker'])
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({
        id: 't1',
        status: 'merge_ready',
        lastReviewVerdict: 'PASS',
        baseSha: (await readContractBaseSha(dest)) ?? undefined,
        implementationSha: await taskWorktreeHeadSha(dest),
      })],
    })
    await execFileAsync('git', ['-C', root, 'switch', '-q', 'Main'])
    const mainBefore = (await execFileAsync('git', ['-C', root, 'rev-parse', 'main'])).stdout.trim()
    const service = new DevloopService(new Context(), resolveConfig({ root, tickIntervalMs: 60_000, enabled: false }), new RecordingBackend())
    services.push(service)
    await service.tick()
    expect((await loadState(root, Date.now())).supervisor).toEqual({ taskId: 't1', reason: 'merge_onto_trunk' })
    expect((await execFileAsync('git', ['-C', root, 'rev-parse', 'main'])).stdout.trim()).toBe(mainBefore)
  })

  it('git-merges PASS work, deletes the worktree, and does not call AgentBackend', async () => {
    const root = await mkdtempInRepo('devloop-svc-merge-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initWorkRepo(root)
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
        implementationSha: await taskWorktreeHeadSha(dest),
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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

  it('does not overwrite a kill switch with a late delegate failure', async () => {
    const root = await mkdtempInRepo('devloop-svc-late-failure-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initWorkRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Late failure' })],
    })
    let release!: () => void
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const backend: AgentBackend = {
      async run() {
        started()
        await new Promise<void>(resolve => { release = resolve })
        return { status: 'failed', detail: 'late failure' }
      },
      async cancel() {},
      async health() { return 'ok' },
    }
    const service = new DevloopService(new Context(), resolveConfig({
      root,
      enabled: false,
      tickIntervalMs: 60_000,
    }), backend)
    services.push(service)
    const tick = service.tick()
    await running
    const latched = await loadState(root, Date.now())
    const stopped = await saveState(root, { ...latched, killSwitch: true }, {
      expectedRevision: latched.revision,
      action: 'test:kill-switch',
    })
    release()
    await tick
    const final = await loadState(root, Date.now())
    expect(final).toEqual(stopped)
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
    await initWorkRepo(root)
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
      '--output-format',
      'json',
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
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
    await initWorkRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist', allowedPaths: ['src.txt'] })],
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
        return {
          status: 'started',
          outcome: {
            version: 1, kind: 'implementation', taskId: 'd1', outcome: 'completed', summary: 'done',
          },
        }
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
    await initWorkRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', title: 'Add persist', allowedPaths: ['src.txt'] })],
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
        return {
          status: 'started',
          outcome: {
            version: 1, kind: 'implementation', taskId: 'd1', outcome: 'completed', summary: 'done',
          },
        }
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

/**
 * The README's Quick start sells this, so it needs an anchor: with the default
 * backend you get the loop, its state and its questions, and your source is not
 * touched. It is true today only because `NoopBackend` returns no outcome, so a
 * fresh workspace never grows a task — and the first version of this test found
 * the promise was being stated too broadly, because a workspace that already
 * has one does reach `prepareDelegateWorktree`, which creates a git branch.
 */
describe('the default backend leaves the source alone', () => {
  const services: DevloopService[] = []
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
  })

  async function armed(tasks: ReturnType<typeof makeTask>[]): Promise<string> {
    const root = await mkdtempInRepo('devloop-noop-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initWorkRepo(root)
    await writeFile(join(root, 'source.ts'), 'export const untouched = 1\n', 'utf8')
    await saveState(root, { ...emptyState(Date.now()), tasks })
    return root
  }

  async function tick(root: string, beats: number): Promise<void> {
    const service = new DevloopService(new Context(), resolveConfig({ root, enabled: false }))
    services.push(service)
    for (let beat = 0; beat < beats; beat += 1) await service.tick()
  }

  it('does nothing at all to a workspace that has only a goal', async () => {
    // The Quick start's own path: GOAL.md and no tasks yet.
    const root = await armed([])
    const before = await entriesOutsideDevloop(root)
    const startedAt = (await loadState(root, Date.now())).revision
    await tick(root, 5)

    expect(await entriesOutsideDevloop(root)).toEqual(before)
    expect(await gitBranchesNamed(root, 'devloop/')).toEqual([])
    // The control, and it has to be a comparison: `revision > 0` was already
    // true before the first tick, so it would have held for a loop that never
    // ran and proved nothing about the assertions above.
    expect((await loadState(root, Date.now())).revision).toBeGreaterThan(startedAt)
    await rm(root, { recursive: true, force: true })
  })

  it('creates a branch but no source edits once a task exists', async () => {
    const root = await armed([makeTask({ id: 'd1', status: 'ready' })])
    const before = await entriesOutsideDevloop(root)
    await tick(root, 5)

    // What the README promises, and the part that matters to an operator.
    expect(await entriesOutsideDevloop(root)).toEqual(before)
    expect(await readFile(join(root, 'source.ts'), 'utf8')).toBe('export const untouched = 1\n')
    // And the part it would have been dishonest to leave out: the worktree is
    // prepared before any backend is consulted, so the branch appears even
    // though no model was ever called.
    expect(await gitBranchesNamed(root, 'devloop/')).toEqual(['devloop/d1'])
    await rm(root, { recursive: true, force: true })
  })
})

describe('acceptance gates the review, not just the log', () => {
  const services: DevloopService[] = []
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
  })

  /**
   * The load-bearing case: a task whose checks fail must never reach a
   * reviewer. Asserting only that a check ran would leave the feature free to
   * be broken while every test stayed green.
   */
  async function runWith(acceptance: string[][]): Promise<{ root: string; seen: string[]; logged: string[] }> {
    const root = await mkdtempInRepo('devloop-accept-svc-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initWorkRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      tasks: [makeTask({ id: 'd1', status: 'ready', allowedPaths: ['src/**'] })],
    })

    const seen: string[] = []
    const backend: AgentBackend = {
      async run(input: AgentRunInput): Promise<AgentRunResult> {
        seen.push(input.action.type)
        if (input.action.type === 'review') {
          // Echoes the commit under review, so the pass case can proceed and
          // the fail case's missing review means something.
          return {
            status: 'started',
            agent: 'test/reviewer',
            outcome: {
              version: 1, kind: 'review', taskId: 'd1',
              reviewedSha: input.contract?.implementationSha ?? '',
              verdict: 'PASS',
            },
          }
        }
        if (input.action.type !== 'delegate') return { status: 'started' }
        // A worker that writes something and declares itself finished.
        await mkdir(join(input.worktreeRoot ?? root, 'src'), { recursive: true })
        await writeFile(join(input.worktreeRoot ?? root, 'src', 'added.ts'), 'export const x = 1\n', 'utf8')
        return {
          status: 'started',
          agent: 'test/worker',
          outcome: {
            version: 1, kind: 'implementation', taskId: 'd1',
            outcome: 'completed', summary: 'done',
          },
        }
      },
      async cancel() {},
      async health() { return 'ok' },
    }
    const ctx = new Context()
    const logged: string[] = []
    const errors = ctx.logger.error.bind(ctx.logger)
    ctx.logger.error = (message: unknown, ...rest: unknown[]): void => {
      logged.push(String(message))
      void errors
      void rest
    }
    const service = new DevloopService(
      ctx,
      resolveConfig({ root, enabled: false, acceptance }),
      backend,
    )
    services.push(service)
    await service.tick()
    await service.tick()
    return { root, seen, logged }
  }

  it('lets a task through to review when the checks pass', async () => {
    const { root, seen } = await runWith([['true']])
    expect(seen).toEqual(['delegate', 'review'])
    const state = await loadState(root, Date.now())
    // Reviewed and accepted: the checks let it through.
    expect(state.tasks[0]?.status).toBe('merge_ready')
    expect(state.supervisor).toBeNull()
    await rm(root, { recursive: true, force: true })
  })

  // The control is the point: a genuine commit failure must still say so, or
  // "log whatever the reason was" degenerates into logging nothing specific.
  it('names the step that actually refused, not the one that already succeeded', async () => {
    const { root, logged } = await runWith([['false']])
    expect(logged.some(line => line.includes('acceptance_failed'))).toBe(true)
    // The commit had already happened by the time acceptance ran.
    expect(logged.some(line => line.includes('parent commit failed'))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  it('holds the task and never dispatches a review when a check fails', async () => {
    const { root, seen } = await runWith([['false']])
    const state = await loadState(root, Date.now())
    // The worker's own claim of completion is not enough.
    expect(state.tasks[0]?.status).not.toBe('review_pending')
    expect(state.supervisor?.reason).toMatch(/^acceptance_failed/)
    expect(seen).not.toContain('review')
    await rm(root, { recursive: true, force: true })
  })
})

async function entriesOutsideDevloop(root: string): Promise<string[]> {
  const names = await readdir(root)
  return names.filter(name => name !== '.devloop' && name !== '.git').sort()
}

async function gitBranchesNamed(root: string, prefix: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)('git', ['branch', '--format=%(refname:short)'], { cwd: root })
  return stdout.split('\n').map(line => line.trim()).filter(name => name.startsWith(prefix)).sort()
}

describe('saving a result while the state lock is busy', () => {
  const log = { error() {} }
  const services: DevloopService[] = []
  afterEach(() => { for (const service of services.splice(0)) service.stop() })
  const planResult = {
    status: 'started' as const,
    agent: 'codex/gpt-6-astra',
    outcome: { version: 1 as const, kind: 'plan' as const, tasks: [{ id: 'T1', title: 'x', tier: 'T1' as const, risk: 'low' as const, allowedPaths: ['src/**'], acceptance: ['a'] }] },
  }
  async function planned(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await saveState(root, { ...emptyState(Date.now()), lastAction: { type: 'plan' } })
    return root
  }
  const holdLock = (root: string, ms: number) => withStateLock(root, () => new Promise(resolve => setTimeout(resolve, ms)))

  it('waits for the lock and saves the result instead of dropping it', async () => {
    const root = await planned('devloop-result-wait-')
    const holding = holdLock(root, 300)
    await new Promise(resolve => setTimeout(resolve, 20))
    await persistAgentTransition(root, { type: 'plan' }, planResult, undefined, log, 2_000)
    await holding
    const state = await loadState(root, Date.now())
    expect(state.tasks.map(t => t.id)).toEqual(['T1'])
    expect(await readFile(join(root, '.devloop', 'EVENTS.jsonl'), 'utf8')).toContain('"action":"result:plan"')
  })

  it('gives up at its deadline rather than waiting forever', async () => {
    const root = await planned('devloop-result-deadline-')
    const holding = holdLock(root, 500)
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(persistAgentTransition(root, { type: 'plan' }, planResult, undefined, log, 100)).rejects.toThrow('result_transition_lock_busy')
    await holding
  })

  it('leaves a hold it could not write for the next tick, which applies it once', async () => {
    const root = await planned('devloop-pending-hold-')
    await saveState(root, { ...(await loadState(root, Date.now())), tasks: [makeTask({ id: 'T1', status: 'review_pending' })] }, { expectedRevision: 1 })
    const holding = holdLock(root, 400)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await persistAgentHold(root, 'T1', 'result_transition_failed', log)).toBe(false)
    await holding
    await expect(readFile(join(root, '.devloop', 'PENDING_HOLD'), 'utf8')).resolves.toContain('result_transition_failed')

    const service = new DevloopService(new Context(), resolveConfig({ root, tickIntervalMs: 60_000, enabled: false }), new RecordingBackend())
    services.push(service)
    await service.tick()
    expect((await loadState(root, Date.now())).supervisor).toEqual({ taskId: 'T1', reason: 'result_transition_failed' })
    await expect(readFile(join(root, '.devloop', 'PENDING_HOLD'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a corrupt pending hold instead of reading it every tick, and changes nothing else', async () => {
    const root = await planned('devloop-pending-corrupt-')
    await writeFile(join(root, '.devloop', 'PENDING_HOLD'), '{ not json', 'utf8')
    const before = await loadState(root, Date.now())
    const service = new DevloopService(new Context(), resolveConfig({ root, tickIntervalMs: 60_000, enabled: false }), new RecordingBackend())
    services.push(service)
    await service.tick()
    await expect(readFile(join(root, '.devloop', 'PENDING_HOLD'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await loadState(root, Date.now())).supervisor).toBe(before.supervisor)
  })

  it('removes a symlinked marker without touching its target, and keeps one it merely cannot read', async () => {
    const root = await planned('devloop-pending-kinds-')
    const target = join(await mkdtemp(join(tmpdir(), 'devloop-pending-target-')), 'hold')
    await writeFile(target, '{"taskId":null,"reason":"result_transition_failed"}\n', 'utf8')
    await symlink(target, join(root, '.devloop', 'PENDING_HOLD'))
    const service = new DevloopService(new Context(), resolveConfig({ root, tickIntervalMs: 60_000, enabled: false }), new RecordingBackend())
    services.push(service)
    await service.tick()
    await expect(lstat(join(root, '.devloop', 'PENDING_HOLD'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(target, 'utf8')).resolves.toContain('result_transition_failed')
    expect((await loadState(root, Date.now())).supervisor).toBeNull()

    // Unreadable is not corrupt: a transient failure must not delete a real hold — nor pass unsaid.
    const marker = join(root, '.devloop', 'PENDING_HOLD')
    await writeFile(marker, '{"taskId":null,"reason":"result_transition_failed"}\n', { mode: 0o000 })
    const logged: string[] = []
    const error = service.ctx.logger.error.bind(service.ctx.logger)
    service.ctx.logger.error = (message: unknown): void => { logged.push(String(message)); void error }
    await service.tick()
    await expect(lstat(marker)).resolves.toBeTruthy()
    expect(logged.some(line => line.includes('PENDING_HOLD marker unreadable'))).toBe(true)
    await chmod(marker, 0o600)
  })

  it('says nothing when there is no marker at all', async () => {
    const root = await planned('devloop-pending-none-')
    const service = new DevloopService(new Context(), resolveConfig({ root, tickIntervalMs: 60_000, enabled: false }), new RecordingBackend())
    services.push(service)
    const logged: string[] = []
    service.ctx.logger.error = (message: unknown): void => { logged.push(String(message)) }
    await service.tick()
    await service.tick()
    expect(logged.filter(line => line.includes('PENDING_HOLD'))).toEqual([])
  })

  it('never treats a directory in the marker\'s place as a hold', async () => {
    const root = await planned('devloop-pending-dir-')
    await mkdir(join(root, '.devloop', 'PENDING_HOLD'))
    const service = new DevloopService(new Context(), resolveConfig({ root, tickIntervalMs: 60_000, enabled: false }), new RecordingBackend())
    services.push(service)
    await service.tick()
    expect((await loadState(root, Date.now())).supervisor).toBeNull()
  })

  it('drops a pending hold when the loop is already halted, so a resume cannot revive it', async () => {
    const root = await planned('devloop-pending-halted-')
    const current = await loadState(root, Date.now())
    await saveState(root, { ...current, supervisor: { taskId: null, reason: 'backend_failed' }, killSwitch: true }, { expectedRevision: current.revision })
    await writeFile(join(root, '.devloop', 'PENDING_HOLD'), '{"taskId":null,"reason":"result_transition_failed"}\n', 'utf8')
    const service = new DevloopService(new Context(), resolveConfig({ root, tickIntervalMs: 60_000, enabled: false }), new RecordingBackend())
    services.push(service)
    await service.tick()
    expect((await loadState(root, Date.now())).supervisor?.reason).toBe('backend_failed')
    await expect(readFile(join(root, '.devloop', 'PENDING_HOLD'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('the pre-PR checker gates the review', () => {
  const services: DevloopService[] = []
  afterEach(() => { for (const service of services.splice(0)) service.stop() })

  /** A stand-in checker printing `findings` and exiting `code`; records the argv it got. */
  async function checker(findings: object[], code: number, size: object = {}): Promise<{ argv: string[], seen: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'prepr-svc-'))
    const seen = join(dir, 'argv.json')
    await writeFile(join(dir, 'check.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(${JSON.stringify(JSON.stringify({ checker: { rules_version: '1.1.0' }, size: { lines: 340, files: 7, counted_top_dirs: ['src'], ...size }, findings }))})
process.exit(${code})
`, 'utf8')
    return { argv: ['node', join(dir, 'check.mjs')], seen }
  }

  async function runWith(prePrCheck: string[], task: Partial<Task> = {}, onTrunk = false, review: Partial<AgentRunResult> = {}): Promise<{ root: string, reviews: number }> {
    const root = await mkdtempInRepo('devloop-prepr-svc-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    if (onTrunk) await initGitRepo(root)
    else await initWorkRepo(root)
    await saveState(root, { ...emptyState(Date.now()), tasks: [makeTask({ id: 'd1', status: 'ready', allowedPaths: ['src/**'], ...task })] })
    let reviews = 0
    const backend: AgentBackend = {
      async run(input: AgentRunInput): Promise<AgentRunResult> {
        if (input.action.type === 'review') {
          reviews += 1
          return { status: 'started', agent: 'test/reviewer', ...review, outcome: { version: 1, kind: 'review', taskId: 'd1', reviewedSha: input.contract?.implementationSha ?? '', verdict: 'PASS' } }
        }
        await mkdir(join(input.worktreeRoot ?? root, 'src'), { recursive: true })
        await writeFile(join(input.worktreeRoot ?? root, 'src', 'added.ts'), 'export const x = 1\n', 'utf8')
        return { status: 'started', agent: 'test/worker', outcome: { version: 1, kind: 'implementation', taskId: 'd1', outcome: 'completed', summary: 'done' } }
      },
      async cancel() {},
      async health() { return 'ok' },
    }
    const service = new DevloopService(new Context(), resolveConfig({ root, enabled: false, prePrCheck }), backend)
    services.push(service)
    await service.tick()
    await service.tick()
    return { root, reviews }
  }

  it('lets a passing change through to review, and gives the checker the task\'s own diff', async () => {
    const { argv, seen } = await checker([{ rule: 'B1', severity: 'review', message: 'answer it' }], 0)
    const { root, reviews } = await runWith(argv)
    expect(reviews).toBe(1)
    expect((await loadState(root, Date.now())).tasks[0]?.status).toBe('merge_ready')
    const args = JSON.parse(await readFile(seen, 'utf8')) as string[]
    expect(args[args.indexOf('--repo') + 1]).toBe(join(root, '.devloop', 'worktrees', 'd1'))
    // The task's own base, not its head: passing the head would give the checker an empty diff to pass.
    const task = (await loadState(root, Date.now())).tasks[0]
    expect(args[args.indexOf('--base') + 1]).toBe(task?.baseSha)
    expect(task?.baseSha).not.toBe(task?.implementationSha)
    expect(args[args.indexOf('--profile') + 1]).toBe('devloop')
    // The branch the loop works on is recorded at the first delegate: later task pull requests target it.
    expect((await loadState(root, Date.now())).workBranch).toBe('work')
    // The PR log: the check, then the verdict, for the same commit.
    const log = await readPrLog(root)
    expect(log.map(e => e.kind)).toEqual(['check', 'review'])
    expect(log[0]).toMatchObject({ taskId: 'd1', status: 'passed', size: { lines: 340, files: 7 }, rules: ['B1'], blocking: [], checker: { rulesVersion: '1.1.0' } })
    expect(log[1]).toMatchObject({ taskId: 'd1', verdict: 'PASS', reviewer: 'test/reviewer', head: log[0]?.head })
    // No local reviewer was in the way, so the line names none.
    expect('localReviewer' in log[1]!).toBe(false)
  })

  it('names the local reviewer a review went through before the forge, on the PR log line', async () => {
    const { argv } = await checker([], 0)
    const { root } = await runWith(argv, {}, false, { localReviewer: 'claude/opus' })
    const log = await readPrLog(root)
    expect(log[1]).toMatchObject({ kind: 'review', verdict: 'PASS', reviewer: 'test/reviewer', localReviewer: 'claude/opus' })
    // A line whose local reviewer is not text is not ours, and the page never gets it.
    await appendFile(join(root, '.devloop', 'PR-LOG.jsonl'), `${JSON.stringify({ ...log[1], localReviewer: { html: '<b>' } })}\n`, 'utf8')
    expect(await readPrLog(root)).toHaveLength(2)
  })

  it('reviews an elastic-band change with its size on the task, and logs it beside the planner\'s estimate', async () => {
    const limits = { max_lines: 200, max_files: 5, max_top_dirs: 2, elastic_lines: 260, elastic_files: 6, elastic_top_dirs: 3 }
    const { argv } = await checker([{ rule: 'SZ-1', severity: 'review', message: 'elastic' }], 0, { lines: 230, files: 6, band: 'elastic', limits })
    const { root, reviews } = await runWith(argv, { estimate: { lines: 150, files: 4 } })
    expect(reviews).toBe(1)
    expect((await loadState(root, Date.now())).tasks[0]?.overBudget).toBe('230 lines, 6 files, 1 top-level dirs; budget 200/5/2, elastic to 260/6/3')
    expect((await readPrLog(root))[0]).toMatchObject({ kind: 'check', band: 'elastic', estimate: { lines: 150, files: 4 }, size: { lines: 230, files: 6 } })

    // Within budget: no size on the task, and a task the planner gave no estimate logs none.
    const plain = await runWith((await checker([], 0, { lines: 12, files: 1, band: 'normal' })).argv)
    expect((await loadState(plain.root, Date.now())).tasks[0]?.overBudget).toBeUndefined()
    expect((await readPrLog(plain.root))[0]).toMatchObject({ band: 'normal', estimate: null })
  })

  it('keeps the work branch it recorded when the checkout later moves to another branch', async () => {
    const root = await mkdtempInRepo('devloop-prepr-svc-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initWorkRepo(root, 'other')
    await saveState(root, { ...emptyState(Date.now()), workBranch: 'work', tasks: [makeTask({ id: 'd1', status: 'ready', allowedPaths: ['src/**'] })] })
    const service = new DevloopService(new Context(), resolveConfig({ root, enabled: false }), new RecordingBackend())
    services.push(service)
    await service.tick()
    expect((await loadState(root, Date.now())).workBranch).toBe('work')
  })

  it('leaves the work branch unrecorded on a trunk, where the merge guards will stop the loop', async () => {
    const { root } = await runWith((await checker([], 0, { lines: 12, files: 1, band: 'normal' })).argv, {}, true)
    expect((await loadState(root, Date.now())).workBranch).toBeUndefined()
  })

  it.each([
    ['over the size budget', [{ rule: 'SZ-1', severity: 'block' }], 1, /^task_over_budget:340 lines, 7 files$/],
    ['blocked by another rule', [{ rule: 'SZ-2', severity: 'block' }, { rule: 'B2', severity: 'block' }], 1, /^prepr_blocked:SZ-2,B2$/],
    ['without a verdict', [], 2, /^prepr_unavailable:checker exited 2$/],
  ])('holds a change %s, and never pays a reviewer for it', async (_case, findings, code, reason) => {
    const { root, reviews } = await runWith((await checker(findings, code)).argv)
    expect(reviews).toBe(0)
    const state = await loadState(root, Date.now())
    expect(state.supervisor?.reason).toMatch(reason)
    expect(state.tasks[0]?.status).not.toBe('review_pending')
    // Held or not, what the checker said is logged; a checker with no verdict logs that too.
    const log = await readPrLog(root)
    expect(log.map(e => e.kind === 'check' ? e.status : e.kind)).toEqual([code === 2 ? 'unavailable' : 'blocked'])
    expect(log[0]?.kind === 'check' ? log[0].blocking : null).toEqual(findings.filter(f => (f as { severity: string }).severity === 'block').map(f => (f as { rule: string }).rule))
  })
})

describe('a forge review without a recorded work branch', () => {
  const services: DevloopService[] = []
  afterEach(() => { for (const service of services.splice(0)) service.stop() })

  async function reviewing(onTrunk: boolean): Promise<{ root: string, backend: RecordingBackend }> {
    const root = await mkdtempInRepo('devloop-forge-review-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    if (onTrunk) await initGitRepo(root)
    else await initWorkRepo(root)
    // As a loop upgraded mid-task would have it: in review, with no work branch recorded.
    await saveState(root, { ...emptyState(Date.now()), tasks: [makeTask({ id: 'd1', status: 'review_pending', implementationSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), implementer: 'dsh/flash' })] })
    const backend = new RecordingBackend()
    const service = new DevloopService(new Context(), resolveConfig({
      root, enabled: false, agentBackend: 'routed',
      reviewerRoute: { tier: 'T3', backend: 'forge', model: 'pr' },
      forge: { pushUrl: 'git@github.com:acme/widgets.git', reviewers: ['clestons'] },
    } as never), backend)
    services.push(service)
    await service.tick()
    return { root, backend }
  }

  it('records the work branch before the review, so the pull request targets it', async () => {
    const { root, backend } = await reviewing(false)
    expect((await loadState(root, Date.now())).workBranch).toBe('work')
    expect(backend.runs.map(run => [run.action.type, run.workBranch])).toEqual([['review', 'work']])
  })

  it('holds on a trunk instead of reviewing, so no pull request can be opened into it', async () => {
    const { root, backend } = await reviewing(true)
    expect(backend.runs).toEqual([])
    const state = await loadState(root, Date.now())
    expect(state.supervisor?.reason).toBe('merge_onto_trunk')
    expect(state.workBranch).toBeUndefined()
    // No review ran, so none was spent.
    expect(state.usage.reviewCycles.d1 ?? 0).toBe(0)
  })
})

describe('merging on the forge', () => {
  const services: DevloopService[] = []
  const realCreate = forgeMergers.create
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
    forgeMergers.create = realCreate
  })
  const g = (root: string, ...args: string[]) => promisify(execFile)('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]).then(r => r.stdout.trim())

  /** A checkout on `work` whose task the forge has merged: the merge commit is fetched but not yet the checkout's. */
  async function merged(): Promise<{ root: string, merge: string, task: string }> {
    const root = await mkdtempInRepo('devloop-forge-merge-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initWorkRepo(root)
    const base = await g(root, 'rev-parse', 'HEAD')
    const forge = await mkdtempInRepo('devloop-forge-bare-')
    await promisify(execFile)('git', ['clone', '-q', '--bare', root, forge])
    const side = await mkdtempInRepo('devloop-forge-side-')
    await promisify(execFile)('git', ['clone', '-q', '-b', 'work', forge, side])
    await g(side, 'switch', '-q', '-c', 'devloop/d1')
    await writeFile(join(side, 'task.txt'), 'done\n', 'utf8')
    await g(side, 'add', '.')
    await g(side, 'commit', '-q', '-m', 'task')
    const task = await g(side, 'rev-parse', 'HEAD')
    await g(side, 'switch', '-q', 'work')
    await g(side, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #7', 'devloop/d1')
    const merge = await g(side, 'rev-parse', 'HEAD')
    // Fetched ahead of time, so the test needs no network: the fast-forward finds the commit present.
    await g(root, 'fetch', '-q', side, 'work')
    await saveState(root, {
      ...emptyState(Date.now()),
      workBranch: 'work',
      tasks: [makeTask({ id: 'd1', status: 'merge_ready', baseSha: base, implementationSha: task, lastReviewVerdict: 'PASS', implementer: 'dsh/flash', reviewer: 'forge/pr' })],
    })
    return { root, merge, task }
  }

  function forgeService(root: string): DevloopService {
    const service = new DevloopService(new Context(), resolveConfig({
      root, enabled: false, agentBackend: 'routed',
      reviewerRoute: { tier: 'T3', backend: 'forge', model: 'pr' },
      forge: { pushUrl: 'git@github.com:acme/widgets.git', reviewers: ['clestons'] },
    } as never), new RecordingBackend())
    services.push(service)
    return service
  }

  it('merges the reviewed pull request on the forge, then fast-forwards the checkout to its merge commit', async () => {
    const { root, merge, task } = await merged()
    const asked: unknown[] = []
    forgeMergers.create = () => ({ async mergeTask(request) { asked.push(request); return { number: 7, mergeCommit: merge } } })
    await forgeService(root).tick()
    expect(asked).toEqual([{ workspaceRoot: root, taskId: 'd1', sha: task, workBranch: 'work' }])
    expect(await g(root, 'rev-parse', 'HEAD')).toBe(merge)
    expect((await loadState(root, Date.now())).tasks[0]?.status).toBe('done')
  })

  it('holds for a review again when the approval is gone, and as a wedged merge for any other forge refusal', async () => {
    for (const [message, reason] of [
      ['forge_review_gone: pull request 7 is no longer approved', 'no_review_pass'],
      ['forge_pr: pull request 7 no longer targets work', 'merge_wedged'],
      // What gh itself throws carries no prefix: an expired login, a missing binary, a timeout.
      ['Command failed: gh pr merge 7 (exit 1)', 'merge_wedged'],
      ['backend timeout', 'merge_wedged'],
    ] as const) {
      const { root } = await merged()
      forgeMergers.create = () => ({ async mergeTask() { throw new Error(message) } })
      await forgeService(root).tick()
      const state = await loadState(root, Date.now())
      expect(state.supervisor?.reason, message).toBe(reason)
      expect(state.tasks[0]?.status).not.toBe('done')
    }
  })
})

describe('releasing a finished goal on the forge', () => {
  const services: DevloopService[] = []
  const realCreate = forgeMergers.create
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
    forgeMergers.create = realCreate
  })

  async function finished(extra: Record<string, unknown> = {}): Promise<string> {
    const root = await mkdtempInRepo('devloop-release-')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    await initWorkRepo(root)
    await saveState(root, {
      ...emptyState(Date.now()),
      goalCompleted: true,
      workBranch: 'work',
      lastAction: { type: 'stop', reason: 'goal_complete' },
      tasks: [
        makeTask({ id: 'd1', status: 'done', title: 'Add a parser', baseSha: 'c'.repeat(40), implementationSha: 'a'.repeat(40), lastReviewVerdict: 'PASS' }),
        makeTask({ id: 'd2', status: 'done', title: 'Check only', baseSha: 'c'.repeat(40), implementationSha: 'c'.repeat(40), lastReviewVerdict: 'PASS' }),
      ],
      ...extra,
    })
    return root
  }

  function service(root: string, forge = true): DevloopService {
    const made = new DevloopService(new Context(), resolveConfig({
      root, enabled: false, agentBackend: 'routed',
      reviewerRoute: forge ? { tier: 'T3', backend: 'forge', model: 'pr' } : { tier: 'T3', backend: 'claude', model: 'opus' },
      forge: { pushUrl: 'git@github.com:acme/widgets.git', reviewers: ['clestons'] },
    } as never), new RecordingBackend())
    services.push(made)
    return made
  }

  it('opens the release once, waits without writing, keeps a request for changes, and records the merge', async () => {
    const root = await finished()
    const opened: Array<{ title: string, body: string }> = []
    const steps = [{ state: 'waiting' as const, number: 9 }, { state: 'changes' as const, number: 9, notes: 'T2 skipped review' }, { state: 'merged' as const, number: 9, mergeCommit: 'b'.repeat(40) }]
    let advanced = 0
    forgeMergers.create = () => ({
      async mergeTask() { throw new Error('not a task merge') },
      async openRelease(request) { opened.push(request); return { number: 9 } },
      async advanceRelease() { return steps[Math.min(advanced++, steps.length - 1)]! },
    })
    const loop = service(root)
    await loop.tick()
    expect((await loadState(root, Date.now())).release).toEqual({ number: 9, merged: false })
    expect(opened).toHaveLength(1)
    expect(opened[0]?.title).toBe('DevLoop release: work')
    expect(opened[0]?.body).toContain('`d1` Add a parser: head `' + 'a'.repeat(40) + '`, from `devloop/d1`, verdict PASS')
    // A task accepted with no commits of its own had no pull request; the body must not send the reviewer looking for one.
    expect(opened[0]?.body).toContain('`d2` Check only: no change, accepted without a pull request, verdict PASS')
    expect(opened[0]?.body).not.toContain('devloop/d2')
    // How to decide it, from whom: the release is read from GitHub reviews only.
    expect(opened[0]?.body).toContain('Decide with a GitHub review on this pull request')
    expect(opened[0]?.body).toContain('Only reviews from `clestons` of its head commit are read; comments are not read.')
    const before = (await loadState(root, Date.now())).revision
    await loop.tick()
    expect((await loadState(root, Date.now())).revision).toBe(before)
    await loop.tick()
    expect((await loadState(root, Date.now())).release).toEqual({ number: 9, merged: false, changes: 'T2 skipped review' })
    await loop.tick()
    expect((await loadState(root, Date.now())).release).toEqual({ number: 9, merged: true, mergeCommit: 'b'.repeat(40) })
    await loop.tick()
    expect(advanced).toBe(3)
    expect(opened).toHaveLength(1)
  })

  it('leaves a local loop, a goal not finished, and a held one alone', async () => {
    let asked = 0
    forgeMergers.create = () => ({
      async mergeTask() { throw new Error('no') },
      async openRelease() { asked += 1; return { number: 9 } },
      async advanceRelease() { asked += 1; return { state: 'waiting' as const, number: 9 } },
    })
    await service(await finished(), false).tick()
    await service(await finished({ goalCompleted: false })).tick()
    await service(await finished({ supervisor: { taskId: null, reason: 'no_progress' }, killSwitch: true })).tick()
    expect(asked).toBe(0)
  })
})
