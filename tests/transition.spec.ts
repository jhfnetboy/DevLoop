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
        allowedPaths: ['src/**'], acceptance: ['tests pass'],
      }],
    }, { agent: 'codex/planner' })
    expect(next.tasks[0]).toMatchObject({ id: 'T-1', status: 'ready', attempts: 0 })
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
