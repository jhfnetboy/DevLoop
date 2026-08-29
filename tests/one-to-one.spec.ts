import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DevloopService from '../src/service.ts'
import { evaluateBudget, emptyUsage, recordAction } from '../src/budget.ts'
import { NoopBackend, RecordingBackend, runInputFor } from '../src/backend.ts'
import { ClaudeCliBackend, CodexCliBackend } from '../src/cli.ts'
import { DshHeadlessBackend } from '../src/dsh.ts'
import { resolveConfig } from '../src/config.ts'
import { actionKey, decideNextAction } from '../src/loop.ts'
import { workspaceArmed } from '../src/persist.ts'
import { runTick } from '../src/tick.ts'
import { worktreeTaskToken } from '../src/worktree.ts'
import {
  assertReviewerAllowed,
  contractForTask,
  nextEscalation,
  reviewTierFor,
  routeFor,
  RoutingError,
} from '../src/router.ts'
import { makeTask, baseState } from './helpers.ts'

const limits = resolveConfig({}).budget
const table = resolveConfig({}).routing
const root = join(import.meta.dirname, '..')

describe('Plan 0.1.2 plugin bundle 1:1', () => {
  it('declares a DSH bundle patch', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      name: string
      dsh: { bundle: { patch: string } }
    }
    expect(pkg.name).toBe('dsh-devloop')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })

  it('inserts the devloop row', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: devloop')
    expect(patch).toContain('name: dsh-devloop')
  })
})

describe('Plan 0.1.3 decideNextAction 1:1', () => {
  it.each([
    ['kill_switch', baseState({ killSwitch: true, tasks: [makeTask({ id: 'a', status: 'ready' })] }), { type: 'stop', reason: 'kill_switch' }],
    ['goal flag', baseState({ goalCompleted: true }), { type: 'stop', reason: 'goal_complete' }],
    ['supervisor', baseState({ supervisor: { taskId: 'a', reason: 'wait' } }), { type: 'escalate', taskId: 'a', reason: 'wait' }],
    ['review', baseState({ tasks: [makeTask({ id: 'r', status: 'review_pending' })] }), { type: 'review', taskId: 'r' }],
    ['merge', baseState({ tasks: [makeTask({ id: 'm', status: 'merge_ready', lastReviewVerdict: 'PASS' })] }), { type: 'merge', taskId: 'm' }],
    ['delegate', baseState({ tasks: [makeTask({ id: 'd', status: 'ready' })] }), { type: 'delegate', taskId: 'd' }],
    ['plan', baseState(), { type: 'plan' }],
    ['blocked', baseState({ tasks: [makeTask({ id: 'b', status: 'blocked' })] }), { type: 'escalate', taskId: 'b', reason: 'blocked_task' }],
  ] as const)('%s', (_name, state, expected) => {
    expect(decideNextAction(state)).toEqual(expected)
  })

  it('actionKey is stable for work actions', () => {
    expect(actionKey({ type: 'delegate', taskId: 'x' })).toBe('delegate:x')
    expect(actionKey({ type: 'escalate', taskId: null, reason: 'wait' })).toBe('escalate:null:wait')
    expect(actionKey({ type: 'escalate', taskId: '_', reason: 'wait' })).toBe('escalate:id:_:wait')
  })
})

describe('Plan 0.1.4 budget 1:1', () => {
  it.each([
    ['daily_cost_cap', { costUsdDay: 20 }, { type: 'plan' as const }, 'daily_cost_cap'],
    ['session_cost_cap', { costUsdSession: 2 }, { type: 'plan' as const }, 'session_cost_cap'],
    ['max_review_cycles', { reviewCycles: { t: 2 } }, { type: 'review' as const, taskId: 't' }, 'max_review_cycles:t'],
  ])('%s', (_name, usagePatch, next, reason) => {
    const state = baseState({ usage: { ...emptyUsage(0), ...usagePatch } })
    expect(evaluateBudget(state, limits, 0, next)).toMatchObject({ ok: false, reason })
  })

  it('recordAction increments review cycles', () => {
    const usage = recordAction(emptyUsage(0), { type: 'review', taskId: 't' }, 5)
    expect(usage.reviewCycles.t).toBe(1)
  })

  it('caps parallel workers from running tasks, not the stored counter', () => {
    const tasks = Array.from({ length: 5 }, (_, index) => makeTask({ id: `r-${index}`, status: 'running' }))
    const state = baseState({
      tasks: [...tasks, makeTask({ id: 't', status: 'ready' })],
    })
    const result = runTick(state, limits, 0)
    expect(result.skipped).toBe(true)
    expect(result.state.killSwitch).toBe(false)
  })

  it('does not latch a later _ task escalation against a null-task one', () => {
    const first = runTick(baseState({ supervisor: { taskId: null, reason: 'wait' } }), limits, 10)
    expect(first.action).toEqual({ type: 'escalate', taskId: null, reason: 'wait' })
    const second = runTick({
      ...first.state,
      supervisor: { taskId: '_', reason: 'wait' },
    }, limits, 20)
    expect(second.skipped).toBe(false)
    expect(second.action).toEqual({ type: 'escalate', taskId: '_', reason: 'wait' })
  })
})

describe('Plan 0.1.5 router 1:1', () => {
  it('default realizations match ADR-0005', () => {
    expect(routeFor('T0', table).backend).toBe('local')
    expect(routeFor('T1', table)).toMatchObject({ backend: 'dsh', model: 'deepseek-v4-flash' })
    expect(routeFor('T2', table).backend).toBe('dsh')
    expect(routeFor('T3', table).backend).toBe('codex')
  })

  it('reviewer must be strictly above implementer', () => {
    expect(reviewTierFor('T0')).toBe('T1')
    expect(() => assertReviewerAllowed('T0', 'T1')).not.toThrow()
    expect(() => assertReviewerAllowed('T3', 'T3')).toThrow(RoutingError)
    expect(nextEscalation('T2')).toBe('T3')
  })

  it('Task Contract forbids GOAL.md', () => {
    const contract = contractForTask('AUTH-001', 'schema', 'T1', ['src/**'], ['tests pass'], 45, 3)
    expect(contract.forbidden).toContain('.devloop/GOAL.md')
    expect(contract.forbidden).toContain('.devloop/')
    expect(contract.forbidden).toContain('package.json')
    expect(contract.budget.maxAttempts).toBe(3)
  })
})

describe('Plan 0.1.6 file state 1:1', () => {
  it('unarmed without GOAL.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devloop-unarmed-'))
    expect(await workspaceArmed(dir)).toBe(false)
  })
})

describe('Plan 0.1.7 config defaults 1:1', () => {
  it('fills schema defaults from empty config', () => {
    const config = resolveConfig({})
    expect(config.enabled).toBe(true)
    expect(config.tickIntervalMs).toBe(2000)
    expect(config.budget.maxTaskAttempts).toBe(3)
    expect(config.budget.maxCostUsdPerDay).toBe(20)
  })

  it('rejects non-finite cost caps', () => {
    expect(() => resolveConfig({ budget: { maxCostUsdPerDay: Number.POSITIVE_INFINITY } })).toThrow()
    expect(() => resolveConfig({ budget: { maxCostUsdPerSession: Number.NaN } })).toThrow()
  })
})

describe('Features 0.1 1:1', () => {
  it('F1/P1: empty armed state plans instead of chatting', () => {
    expect(decideNextAction(baseState())).toEqual({ type: 'plan' })
  })

  it('F4/P5: daily cap is a stop reason, not a warning', () => {
    const state = baseState({ usage: { ...emptyUsage(0), costUsdDay: 20 } })
    expect(evaluateBudget(state, limits, 0, { type: 'plan' })).toEqual({
      ok: false,
      reason: 'daily_cost_cap',
      taskId: null,
    })
  })

  it('P4: high-risk work escalates before delegate', () => {
    expect(decideNextAction(baseState({
      tasks: [makeTask({ id: 'sec', status: 'ready', risk: 'high' })],
    }))).toEqual({ type: 'escalate', taskId: 'sec', reason: 'security_high_risk' })
  })

  it('T2: decideNextAction does not return a Promise', () => {
    expect(decideNextAction(baseState())).not.toBeInstanceOf(Promise)
  })
})

describe('Plan 0.2.1 AgentBackend recording 1:1', () => {
  it('NoopBackend records, cancels, and reports health', async () => {
    const backend = new NoopBackend()
    const input = runInputFor('/repo', { type: 'plan' }, baseState(), limits)
    await expect(backend.run(input)).resolves.toEqual({ status: 'recorded' })
    await backend.cancel('task-1')
    await expect(backend.health()).resolves.toBe('ok')
  })

  it('DevloopService defaults to NoopBackend when cordis passes only ctx and config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devloop-default-backend-'))
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root: dir, enabled: false }))
    expect(service.backend).toBeInstanceOf(NoopBackend)
    const input = runInputFor(dir, { type: 'plan' }, baseState(), limits)
    await expect(service.backend.run(input)).resolves.toEqual({ status: 'recorded' })
    await expect(service.backend.health()).resolves.toBe('ok')
  })
})

describe('Plan 0.2.2 task-id token', () => {
  it('rejects task ids that are not a single path segment', () => {
    expect(worktreeTaskToken('d1')).toBe('d1')
    expect(worktreeTaskToken('../etc')).toBeNull()
    expect(worktreeTaskToken('a..b')).toBeNull()
  })
})

describe('Plan 0.2.3 DSH headless 1:1', () => {
  it('createBackend returns DshHeadlessBackend when config says dsh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devloop-dsh-backend-'))
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({
      root: dir,
      enabled: false,
      agentBackend: 'dsh',
    }))
    expect(service.backend).toBeInstanceOf(DshHeadlessBackend)
  })
})

describe('Plan 0.2.4 mechanical merge 1:1', () => {
  it('merge_ready without PASS escalates; PASS and PASS_WITH_NOTES merge', () => {
    expect(decideNextAction(baseState({
      tasks: [makeTask({ id: 'm', status: 'merge_ready' })],
    }))).toEqual({ type: 'escalate', taskId: 'm', reason: 'no_review_pass' })
    expect(decideNextAction(baseState({
      tasks: [makeTask({ id: 'm', status: 'merge_ready', lastReviewVerdict: 'REWORK' })],
    }))).toEqual({ type: 'escalate', taskId: 'm', reason: 'no_review_pass' })
    expect(decideNextAction(baseState({
      tasks: [makeTask({ id: 'm', status: 'merge_ready', lastReviewVerdict: 'PASS' })],
    }))).toEqual({ type: 'merge', taskId: 'm' })
    expect(decideNextAction(baseState({
      tasks: [makeTask({ id: 'm', status: 'merge_ready', lastReviewVerdict: 'PASS_WITH_NOTES' })],
    }))).toEqual({ type: 'merge', taskId: 'm' })
  })
})

describe('Plan 0.2.5 T3 CLI adapters 1:1', () => {
  it('createBackend maps claude and codex; default is never RecordingBackend', () => {
    const dir = '/tmp'
    const claude = new DevloopService(new Context(), resolveConfig({
      root: dir,
      enabled: false,
      agentBackend: 'claude',
    }))
    const codex = new DevloopService(new Context(), resolveConfig({
      root: dir,
      enabled: false,
      agentBackend: 'codex',
    }))
    const def = new DevloopService(new Context(), resolveConfig({ root: dir, enabled: false }))
    expect(claude.backend).toBeInstanceOf(ClaudeCliBackend)
    expect(codex.backend).toBeInstanceOf(CodexCliBackend)
    expect(def.backend).toBeInstanceOf(NoopBackend)
    expect(def.backend).not.toBeInstanceOf(RecordingBackend)
    expect(claude.backend).not.toBeInstanceOf(RecordingBackend)
    expect(codex.backend).not.toBeInstanceOf(RecordingBackend)
  })
})
