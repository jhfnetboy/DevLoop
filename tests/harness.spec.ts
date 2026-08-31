import { describe, expect, it } from 'vitest'
import { runInputFor } from '../src/backend.ts'
import { HarnessSubagentBackend } from '../src/harness.ts'
import type { HarnessHost, HarnessParentHandle, HarnessRunHandle } from '../src/harness.ts'
import { resolveConfig } from '../src/config.ts'
import { baseState } from './helpers.ts'

const limits = resolveConfig({}).budget

class FakeHost implements HarnessHost {
  readonly disposed: string[] = []
  provider = true
  stopReason = 'completed'
  output: readonly unknown[] = [{
    type: 'text',
    text: '<devloop_result>{"version":1,"kind":"plan","tasks":[{"id":"T-1","title":"x","tier":"T1","risk":"low","allowedPaths":["src/**"],"acceptance":["ok"]}]}</devloop_result>',
  }]

  hasProvider(_name: string): boolean { return this.provider }

  async createParent(cwd: string): Promise<HarnessParentHandle> {
    return {
      agent: { cwd },
      dispose: async () => { this.disposed.push('parent') },
    }
  }

  async start(name: string, _parent: unknown, _prompt: string): Promise<HarnessRunHandle> {
    return {
      result: Promise.resolve({ output: this.output, stopReason: this.stopReason }),
      dispose: async () => { this.disposed.push(`run:${name}`) },
    }
  }
}

function input() {
  return {
    ...runInputFor('/repo', { type: 'plan' }, baseState(), limits),
    worktreeRoot: '/repo/.devloop/worktrees/_loop-plan',
    route: { tier: 'T3' as const, backend: 'subagent:codex', model: 'gpt-5.4' },
  }
}

describe('HarnessSubagentBackend', () => {
  it('uses a named provider and disposes child before parent', async () => {
    const host = new FakeHost()
    const backend = new HarnessSubagentBackend(host)
    const result = await backend.run(input())
    expect(result).toMatchObject({ status: 'started', agent: 'subagent:codex' })
    expect(result.outcome?.kind).toBe('plan')
    expect(host.disposed).toEqual(['run:codex', 'parent'])
  })

  it('fails before creating resources when the provider is absent', async () => {
    const host = new FakeHost()
    host.provider = false
    const result = await new HarnessSubagentBackend(host).run(input())
    expect(result).toEqual({ status: 'failed', detail: 'no Harness subagent provider registered for codex' })
    expect(host.disposed).toEqual([])
  })

  it('contains child failure and still disposes every owner', async () => {
    const host = new FakeHost()
    host.stopReason = 'error'
    const result = await new HarnessSubagentBackend(host).run(input())
    expect(result).toEqual({ status: 'failed', detail: 'Harness subagent stopped: error' })
    expect(host.disposed).toEqual(['run:codex', 'parent'])
  })
})
