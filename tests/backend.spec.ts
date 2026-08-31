import { describe, expect, it } from 'vitest'
import { RecordingBackend, RoutedBackend, dispatchTick, isAgentAction, runInputFor } from '../src/backend.ts'
import type { AgentBackend, AgentRunInput, AgentRunResult } from '../src/backend.ts'
import { resolveConfig } from '../src/config.ts'
import { makeTask, baseState } from './helpers.ts'

const limits = resolveConfig({}).budget

describe('RecordingBackend', () => {
  it('records run, cancel, and health without spawning', async () => {
    const backend = new RecordingBackend()
    const input = runInputFor('/tmp/ws', { type: 'plan' }, baseState(), limits)
    await expect(backend.run(input)).resolves.toEqual({ status: 'recorded' })
    await backend.cancel('task-1')
    await expect(backend.health()).resolves.toBe('ok')
    expect(backend.runs).toEqual([input])
    expect(backend.cancelled).toEqual(['task-1'])
  })
})

describe('RoutedBackend', () => {
  it('uses distinct planner, worker-tier, and reviewer routes', async () => {
    const config = resolveConfig({})
    const dsh = new RecordingBackend()
    const codex = new RecordingBackend()
    const claude = new RecordingBackend()
    const backend = new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, { dsh, codex, claude })
    const state = baseState({ tasks: [makeTask({ id: 'd1', tier: 'T1', status: 'ready' })] })

    await backend.run(runInputFor('/repo', { type: 'plan' }, state, limits))
    await backend.run(runInputFor('/repo', { type: 'delegate', taskId: 'd1' }, state, limits))
    await backend.run(runInputFor('/repo', { type: 'review', taskId: 'd1' }, state, limits))

    expect(codex.runs[0]?.route).toEqual(config.plannerRoute)
    expect(dsh.runs[0]?.route).toEqual(config.routing.T1)
    expect(claude.runs[0]?.route).toEqual(config.reviewerRoute)
  })

  it('fails closed when reviewer and implementer are the same agent route', async () => {
    const config = resolveConfig({ reviewerRoute: {
      tier: 'T3', backend: 'codex', model: 'gpt-5.4',
    } })
    const backend = new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, { codex: new RecordingBackend() })
    const state = baseState({ tasks: [makeTask({ id: 'd1', tier: 'T3', status: 'review_pending' })] })

    await expect(backend.run(
      runInputFor('/repo', { type: 'review', taskId: 'd1' }, state, limits),
    )).resolves.toEqual({
      status: 'failed',
      detail: 'review route must differ from implementer route codex/gpt-5.4',
    })
  })

  it('routes subagent:<provider> through the optional Harness adapter', async () => {
    const subagent = new RecordingBackend()
    const config = resolveConfig({
      plannerRoute: { tier: 'T3', backend: 'subagent:codex', model: 'gpt-5.4' },
    })
    const backend = new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, { subagent })
    await backend.run(runInputFor('/repo', { type: 'plan' }, baseState(), limits))
    expect(subagent.runs[0]?.route).toEqual(config.plannerRoute)
  })

  it('records the selected route identity instead of an adapter self-report', async () => {
    const config = resolveConfig({})
    const spoofing: AgentBackend = {
      async run() { return { status: 'started', agent: 'spoofed/identity' } },
      async cancel() {},
      async health() { return 'ok' },
    }
    const backend = new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, { codex: spoofing })
    await expect(backend.run(runInputFor('/repo', { type: 'plan' }, baseState(), limits))).resolves.toEqual({
      status: 'started',
      agent: `${config.plannerRoute.backend}/${config.plannerRoute.model}`,
    })
  })

  it('rejects the same native provider even when descriptive model labels differ', async () => {
    const config = resolveConfig({
      reviewerRoute: { tier: 'T3', backend: 'subagent:codex', model: 'review-label' },
      routing: {
        T3: { tier: 'T3', backend: 'subagent:codex', model: 'implement-label' },
      },
    })
    const backend = new RoutedBackend({
      planner: config.plannerRoute,
      reviewer: config.reviewerRoute,
      workers: config.routing,
    }, { subagent: new RecordingBackend() })
    const state = baseState({ tasks: [makeTask({ id: 'd1', tier: 'T3', status: 'review_pending' })] })
    await expect(backend.run(
      runInputFor('/repo', { type: 'review', taskId: 'd1' }, state, limits),
    )).resolves.toMatchObject({ status: 'failed' })
  })
})

describe('runInputFor', () => {
  it('attaches no contract for plan', () => {
    const input = runInputFor('/repo', { type: 'plan' }, baseState(), limits)
    expect(input.contract).toBeNull()
    expect(input.workspaceRoot).toBe('/repo')
  })

  it('freezes the task contract on delegate', () => {
    const task = makeTask({
      id: 'd1',
      status: 'ready',
      title: 'Add persist',
      allowedPaths: ['src/persist.ts'],
      acceptance: ['tests pass'],
    })
    const input = runInputFor(
      '/repo',
      { type: 'delegate', taskId: 'd1' },
      baseState({ tasks: [task] }),
      limits,
    )
    expect(input.contract).toEqual({
      taskId: 'd1',
      title: 'Add persist',
      tier: 'T1',
      allowedPaths: ['src/persist.ts'],
      forbidden: ['package.json', '.devloop/GOAL.md', '.devloop/'],
      acceptance: ['tests pass'],
      budget: { maxMinutes: limits.taskTimeoutMinutes, maxAttempts: limits.maxTaskAttempts },
    })
  })

  it('leaves contract null when the task id is missing', () => {
    const input = runInputFor(
      '/repo',
      { type: 'review', taskId: 'ghost' },
      baseState(),
      limits,
    )
    expect(input.contract).toBeNull()
  })
})

describe('isAgentAction', () => {
  it('sends plan/delegate/review to the backend, not merge', () => {
    expect(isAgentAction({ type: 'plan' })).toBe(true)
    expect(isAgentAction({ type: 'delegate', taskId: 'a' })).toBe(true)
    expect(isAgentAction({ type: 'review', taskId: 'a' })).toBe(true)
    expect(isAgentAction({ type: 'merge', taskId: 'a' })).toBe(false)
    expect(isAgentAction({ type: 'idle' })).toBe(false)
    expect(isAgentAction({ type: 'stop', reason: 'budget' })).toBe(false)
  })
})

describe('dispatchTick', () => {
  const logs: string[] = []
  const log = { error: (message: string) => { logs.push(message) } }

  it('skips backend.run when delegate/review has no matching task', async () => {
    const backend = new RecordingBackend()
    await dispatchTick(
      backend,
      '/repo',
      { type: 'review', taskId: 'ghost' },
      baseState(),
      limits,
      log,
    )
    expect(backend.runs).toHaveLength(0)
    expect(logs.some(line => line.includes('missing task ghost'))).toBe(true)
  })

  it('does not dispatch merge', async () => {
    const backend = new RecordingBackend()
    await dispatchTick(
      backend,
      '/repo',
      { type: 'merge', taskId: 'm1' },
      baseState({ tasks: [makeTask({ id: 'm1', status: 'merge_ready', lastReviewVerdict: 'PASS' })] }),
      limits,
      log,
    )
    expect(backend.runs).toHaveLength(0)
  })

  it('logs a throw without retrying', async () => {
    const backend: AgentBackend = {
      async run(_input: AgentRunInput): Promise<AgentRunResult> {
        throw new Error('boom')
      },
      async cancel() {},
      async health() { return 'ok' },
    }
    await expect(dispatchTick(
      backend,
      '/repo',
      { type: 'plan' },
      baseState(),
      limits,
      log,
    )).resolves.toBeUndefined()
    expect(logs.some(line => line.includes('backend threw'))).toBe(true)
  })

  it('logs status=failed without throwing', async () => {
    const backend: AgentBackend = {
      async run(): Promise<AgentRunResult> {
        return { status: 'failed', detail: 'nope' }
      },
      async cancel() {},
      async health() { return 'ok' },
    }
    await dispatchTick(backend, '/repo', { type: 'plan' }, baseState(), limits, log)
    expect(logs.some(line => line.includes('backend failed: nope'))).toBe(true)
  })

  it('returns the adapter result so the host can commit after started', async () => {
    const backend = new RecordingBackend()
    await expect(dispatchTick(
      backend,
      '/repo',
      { type: 'plan' },
      baseState(),
      limits,
      log,
    )).resolves.toEqual({ status: 'recorded' })
  })
})
