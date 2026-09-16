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

  it('gives each goal after the first its own task ids, so its branches never meet an earlier goal\'s', () => {
    const plan = (id: string) => ({ version: 1 as const, kind: 'plan' as const, tasks: [{ id, title: 'Do it', tier: 'T1' as const, risk: 'low' as const, allowedPaths: ['src/**'], acceptance: ['ok'] }] })
    const first = { ...emptyState(0), lastAction: { type: 'plan' as const } }
    expect(applyAgentResult(first, { type: 'plan' }, plan('TASK-001'), {}).tasks[0]?.id).toBe('TASK-001')
    const third = { ...first, goal: { number: 3, startedAt: '2026-09-13T08:00:00.000Z' } }
    expect(applyAgentResult(third, { type: 'plan' }, plan('TASK-001'), {}).tasks[0]?.id).toBe('g3-TASK-001')
    // An id the prefix pushes past the limit is refused, not cut into a different or clashing id.
    expect(() => applyAgentResult(third, { type: 'plan' }, plan('T'.repeat(62)), {})).toThrow(/result_task_mismatch/)
  })

  it('prepends a host-authored planning-docs task when the readiness check found none', () => {
    const state = { ...emptyState(0), lastAction: { type: 'plan' as const } }
    const result = {
      version: 1 as const, kind: 'plan' as const,
      tasks: [{ id: 'T-1', title: 'Do it', tier: 'T1' as const, risk: 'low' as const, allowedPaths: ['src/**'], acceptance: ['ok'] }],
    }
    const next = applyAgentResult(state, { type: 'plan' }, result, {
      agent: 'codex/planner',
      seedPlanningDocsTask: { docsDir: 'docs/agent', goalText: 'Ship the thing' },
    })
    expect(next.tasks).toHaveLength(2)
    expect(next.tasks[0]).toMatchObject({
      id: 'plan-docs', status: 'ready', tier: 'T2', risk: 'low', allowedPaths: ['docs/agent/**'],
    })
    expect(next.tasks[0]?.acceptance.join(' ')).toContain('Ship the thing')
    expect(next.tasks[1]?.id).toBe('T-1')
  })

  it('does not seed a planning-docs task when the option is absent (documents already exist)', () => {
    const state = { ...emptyState(0), lastAction: { type: 'plan' as const } }
    const result = { version: 1 as const, kind: 'plan' as const, tasks: [{ id: 'T-1', title: 'Do it', tier: 'T1' as const, risk: 'low' as const, allowedPaths: ['src/**'], acceptance: ['ok'] }] }
    const next = applyAgentResult(state, { type: 'plan' }, result, { agent: 'codex/planner' })
    expect(next.tasks.map(task => task.id)).toEqual(['T-1'])
  })

  it('refuses a plan that reuses the reserved id instead of silently merging with the seed', () => {
    const state = { ...emptyState(0), lastAction: { type: 'plan' as const } }
    const result = {
      version: 1 as const, kind: 'plan' as const,
      tasks: [{ id: 'plan-docs', title: 'Something else', tier: 'T1' as const, risk: 'low' as const, allowedPaths: ['src/**'], acceptance: ['ok'] }],
    }
    expect(() => applyAgentResult(state, { type: 'plan' }, result, {
      agent: 'codex/planner',
      seedPlanningDocsTask: { docsDir: 'docs/agent', goalText: 'Ship the thing' },
    })).toThrow(/result_task_mismatch.*plan-docs/)
  })

  it('gives the seeded task the same goal-number prefix as everything else the planner returned', () => {
    const state = {
      ...emptyState(0),
      goal: { number: 2, startedAt: '2026-09-13T08:00:00.000Z' },
      lastAction: { type: 'plan' as const },
    }
    const result = {
      version: 1 as const, kind: 'plan' as const,
      tasks: [{ id: 'T-1', title: 'Do it', tier: 'T1' as const, risk: 'low' as const, allowedPaths: ['src/**'], acceptance: ['ok'] }],
    }
    const next = applyAgentResult(state, { type: 'plan' }, result, {
      agent: 'codex/planner',
      seedPlanningDocsTask: { docsDir: 'docs/agent', goalText: 'Ship the thing' },
    })
    expect(next.tasks.map(task => task.id)).toEqual(['g2-plan-docs', 'g2-T-1'])
  })

  it('bounds the goal text folded into the seeded task, rather than an unbounded GOAL.md', () => {
    const state = { ...emptyState(0), lastAction: { type: 'plan' as const } }
    const result = { version: 1 as const, kind: 'plan' as const, tasks: [] }
    const huge = 'x'.repeat(20_000)
    const next = applyAgentResult(state, { type: 'plan' }, result, {
      agent: 'codex/planner',
      seedPlanningDocsTask: { docsDir: 'docs/agent', goalText: huge },
    })
    const acceptance = next.tasks[0]?.acceptance.join(' ') ?? ''
    expect(acceptance.length).toBeLessThan(huge.length)
    expect(acceptance).toContain('first 8192 characters')
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

  it('keeps a request for rework\'s notes for the next attempt, and drops them once that attempt is handed in', () => {
    const sha = 'a'.repeat(40)
    const reviewing = {
      ...emptyState(0),
      tasks: [makeTask({ id: 'T-1', status: 'review_pending', implementationSha: sha, implementer: 'dsh/flash' })],
      lastAction: { type: 'review' as const, taskId: 'T-1' },
    }
    const review = (verdict: 'REWORK' | 'PASS_WITH_NOTES', notes?: string) => applyAgentResult(reviewing, reviewing.lastAction, {
      version: 1, kind: 'review', taskId: 'T-1', reviewedSha: sha, verdict, ...(notes ? { notes } : {}),
    }, { agent: 'github:clestons' }).tasks[0]
    expect(review('REWORK', 'Split the parser out.')?.reviewNotes).toBe('Split the parser out.')
    expect(review('REWORK')?.reviewNotes).toBeUndefined()
    expect(review('PASS_WITH_NOTES', 'nice')?.reviewNotes).toBeUndefined()

    const redo = { ...reviewing, tasks: [{ ...review('REWORK', 'Split the parser out.')!, status: 'ready' as const }], lastAction: { type: 'delegate' as const, taskId: 'T-1' } }
    const handedIn = applyAgentResult(redo, redo.lastAction, { version: 1, kind: 'implementation', taskId: 'T-1', outcome: 'completed', summary: 'split' }, { agent: 'dsh/flash', implementationSha: 'b'.repeat(40) })
    expect(handedIn.tasks[0]?.reviewNotes).toBeUndefined()
    // An attempt that failed or blocked is retried, and the retry still needs them.
    for (const outcome of ['failed', 'blocked'] as const) {
      const notHandedIn = applyAgentResult(redo, redo.lastAction, { version: 1, kind: 'implementation', taskId: 'T-1', outcome, summary: 'no' }, { agent: 'dsh/flash' })
      expect(notHandedIn.tasks[0]?.reviewNotes, outcome).toBe('Split the parser out.')
    }
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
