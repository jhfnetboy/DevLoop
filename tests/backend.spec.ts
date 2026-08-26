import { describe, expect, it } from 'vitest'
import { RecordingBackend, dispatchTick, isAgentAction, runInputFor } from '../src/backend.ts'
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
      baseState({ tasks: [makeTask({ id: 'm1', status: 'merge_ready' })] }),
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
})
