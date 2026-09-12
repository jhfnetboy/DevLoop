import { describe, expect, it } from 'vitest'
import type { AgentBackend, AgentRunInput, AgentRunResult } from '../src/backend.ts'
import { resolveConfig } from '../src/config.ts'
import { ForgePrBackend } from '../src/forge.ts'
import { LocalThenForgeReview } from '../src/review-chain.ts'
import { contractForTask } from '../src/router.ts'
import { forgeReview } from '../src/service.ts'
import type { ReviewVerdict } from '../src/types.ts'

const SHA = 'a'.repeat(40)
const LOCAL = { tier: 'T3' as const, backend: 'claude', model: 'opus' }
const input = (type: 'review' | 'delegate' = 'review'): AgentRunInput => ({
  action: { type, taskId: 'T1' },
  contract: contractForTask('T1', 't', 'T1', ['src/**'], ['ok'], 45, 3, 'b'.repeat(40), SHA),
  workspaceRoot: '/repo',
  worktreeRoot: null,
})

function fake(result: AgentRunResult): AgentBackend & { calls: AgentRunInput[] } {
  const calls: AgentRunInput[] = []
  return { calls, async run(i) { calls.push(i); return result }, async cancel() {}, async health() { return 'ok' } }
}
const verdict = (v: ReviewVerdict): AgentRunResult => ({ status: 'started', agent: 'claude/opus', outcome: { version: 1, kind: 'review', taskId: 'T1', reviewedSha: SHA, verdict: v } })

describe('a local review before the forge', () => {
  it('opens the pull request only for a change the local reviewer passed', async () => {
    for (const passing of ['PASS', 'PASS_WITH_NOTES'] as const) {
      const local = fake(verdict(passing))
      const forge = fake(verdict('PASS'))
      expect(await new LocalThenForgeReview(local, LOCAL, forge).run(input())).toBe(await forge.run(input()))
      expect(local.calls[0]?.route).toEqual(LOCAL)
      expect(forge.calls).toHaveLength(2)
    }
  })

  it('takes a local rework, replan, block or failure as the answer, and never asks the forge', async () => {
    for (const result of [verdict('REWORK'), verdict('REPLAN'), verdict('BLOCKED'), { status: 'failed', detail: 'claude down' } as AgentRunResult]) {
      const forge = fake(verdict('PASS'))
      expect(await new LocalThenForgeReview(fake(result), LOCAL, forge).run(input())).toEqual(result)
      expect(forge.calls).toHaveLength(0)
    }
  })

  it('sends anything but a review straight to the forge', async () => {
    const local = fake(verdict('PASS'))
    const forge = fake({ status: 'failed', detail: 'forge_role' })
    await new LocalThenForgeReview(local, LOCAL, forge).run(input('delegate'))
    expect(local.calls).toHaveLength(0)
    expect(forge.calls).toHaveLength(1)
  })

  it('is what the forge route is when localReview is set, and never a route that implements', () => {
    const registry = { claude: fake(verdict('PASS')), dsh: fake(verdict('PASS')) }
    const base = { agentBackend: 'routed' as const, reviewerRoute: { backend: 'forge', model: 'pr' } }
    expect(forgeReview(resolveConfig(base), registry)).toBeInstanceOf(ForgePrBackend)
    expect(forgeReview(resolveConfig({ ...base, forge: { localReview: LOCAL } } as never), registry)).toBeInstanceOf(LocalThenForgeReview)
    const implementer = resolveConfig({ ...base, forge: { localReview: { backend: 'dsh', model: 'deepseek-v4-flash' } } } as never)
    expect(() => forgeReview(implementer, registry)).toThrow(/also implements tasks/)
    expect(() => forgeReview(resolveConfig({ ...base, forge: { localReview: { backend: 'forge', model: 'x' } } } as never), registry)).toThrow(/not the forge/)
    expect(() => forgeReview(resolveConfig({ ...base, forge: { localReview: { backend: 'nobody', model: 'x' } } } as never), registry)).toThrow(/no backend adapter/)
  })
})
