import { describe, expect, it } from 'vitest'
import { emptyState } from '../src/persist.ts'
import { applyAgentResult } from '../src/transition.ts'
import { makeTask } from './helpers.ts'

describe('agent result transitions', () => {
  it('creates ready tasks from a plan', () => {
    const state = { ...emptyState(0), lastAction: { type: 'plan' as const } }
    const next = applyAgentResult(state, { type: 'plan' }, {
      version: 1,
      kind: 'plan',
      tasks: [{
        id: 'T-1', title: 'Do it', tier: 'T1', risk: 'low',
        allowedPaths: ['src/**'], acceptance: ['tests pass'], estimate: { lines: 120, files: 3 },
      }],
    }, { agent: 'codex/planner' })
    // The planner is recorded on every task it created, beside implementer and
    // reviewer, so all three roles of a routed run can be read back from STATE.
    expect(next.tasks[0]).toMatchObject({ id: 'T-1', status: 'ready', attempts: 0, planner: 'codex/planner' })
    // The planner's estimate reaches the task, where the PR log reads it beside the checker's count.
    expect(next.tasks[0]?.estimate).toEqual({ lines: 120, files: 3 })
  })

  it('moves a completed implementation to SHA-bound review', () => {
    const sha = 'a'.repeat(40)
    const state = {
      ...emptyState(0),
      tasks: [makeTask({ id: 'T-1', status: 'ready' })],
      usage: { ...emptyState(0).usage, taskAttempts: { 'T-1': 1 } },
      lastAction: { type: 'delegate' as const, taskId: 'T-1' },
    }
    const next = applyAgentResult(state, state.lastAction, {
      version: 1, kind: 'implementation', taskId: 'T-1', outcome: 'completed', summary: 'done',
    }, { agent: 'dsh/flash', implementationSha: sha })
    expect(next.tasks[0]).toMatchObject({
      status: 'review_pending', implementationSha: sha, implementer: 'dsh/flash', attempts: 1,
    })
  })

  it('records an elastic-band size with its commit, and drops it when the next attempt is back within budget', () => {
    const state = {
      ...emptyState(0),
      tasks: [makeTask({ id: 'T-1', status: 'ready' })],
      lastAction: { type: 'delegate' as const, taskId: 'T-1' },
    }
    const done = { version: 1, kind: 'implementation', taskId: 'T-1', outcome: 'completed', summary: 'done' } as const
    const big = applyAgentResult(state, state.lastAction, done, { agent: 'dsh/flash', implementationSha: 'a'.repeat(40), overBudget: '230 lines, 6 files' })
    expect(big.tasks[0]?.overBudget).toBe('230 lines, 6 files')
    const again = { ...big, tasks: [{ ...big.tasks[0]!, status: 'rework' as const }] }
    const small = applyAgentResult(again, state.lastAction, done, { agent: 'dsh/flash', implementationSha: 'b'.repeat(40) })
    expect(small.tasks[0]?.overBudget).toBeUndefined()
  })

  it('rejects stale and same-identity review results', () => {
    const sha = 'a'.repeat(40)
    const state = {
      ...emptyState(0),
      tasks: [makeTask({
        id: 'T-1', status: 'review_pending', implementationSha: sha, implementer: 'dsh/flash',
      })],
      lastAction: { type: 'review' as const, taskId: 'T-1' },
    }
    expect(() => applyAgentResult(state, state.lastAction, {
      version: 1, kind: 'review', taskId: 'T-1', reviewedSha: 'b'.repeat(40), verdict: 'PASS',
    }, { agent: 'claude/opus' })).toThrow('stale_review_sha')
    expect(() => applyAgentResult(state, state.lastAction, {
      version: 1, kind: 'review', taskId: 'T-1', reviewedSha: sha, verdict: 'PASS',
    }, { agent: 'dsh/flash' })).toThrow('reviewer_identity')
  })

  it('maps review verdicts without model-driven control flow', () => {
    const sha = 'a'.repeat(40)
    const base = {
      ...emptyState(0),
      tasks: [makeTask({
        id: 'T-1', status: 'review_pending', implementationSha: sha, implementer: 'dsh/flash',
      })],
      lastAction: { type: 'review' as const, taskId: 'T-1' },
    }
    const pass = applyAgentResult(base, base.lastAction, {
      version: 1, kind: 'review', taskId: 'T-1', reviewedSha: sha, verdict: 'PASS',
    }, { agent: 'claude/opus' })
    expect(pass.tasks[0]?.status).toBe('merge_ready')
    const rework = applyAgentResult(base, base.lastAction, {
      version: 1, kind: 'review', taskId: 'T-1', reviewedSha: sha, verdict: 'REWORK',
    }, { agent: 'claude/opus' })
    expect(rework.tasks[0]?.status).toBe('rework')
  })
})
