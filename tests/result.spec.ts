import { describe, expect, it } from 'vitest'
import { parseDevloopResult, validateDevloopResult } from '../src/result.ts'

describe('DevLoop result envelope', () => {
  it('parses a bounded plan from surrounding prose', () => {
    const result = parseDevloopResult(`done\n<devloop_result>${JSON.stringify({
      version: 1,
      kind: 'plan',
      tasks: [{
        id: 'T-1',
        title: 'Add result parser',
        tier: 'T1',
        risk: 'low',
        allowedPaths: ['src/**'],
        acceptance: ['tests pass'],
      }],
    })}</devloop_result>`)
    expect(result.kind).toBe('plan')
    expect(result.kind === 'plan' && result.tasks[0]?.id).toBe('T-1')
  })

  it('rejects unwrapped, duplicate-id, and unsafe plan output', () => {
    expect(() => parseDevloopResult('{"version":1,"kind":"plan"}')).toThrow('missing')
    expect(() => validateDevloopResult({
      version: 1,
      kind: 'plan',
      tasks: [
        { id: 'a', title: 'a', tier: 'T1', risk: 'low', allowedPaths: ['src/**'], acceptance: ['ok'] },
        { id: 'a', title: 'b', tier: 'T1', risk: 'low', allowedPaths: ['src/**'], acceptance: ['ok'] },
      ],
    })).toThrow('unique')
    expect(() => validateDevloopResult({
      version: 1,
      kind: 'plan',
      tasks: [{ id: '../x', title: 'x', tier: 'T1', risk: 'low', allowedPaths: ['src/**'], acceptance: ['ok'] }],
    })).toThrow('unsafe')
  })

  it('rejects multiple result envelopes instead of accepting the last one', () => {
    const result = (id: string) => `<devloop_result>${JSON.stringify({
      version: 1,
      kind: 'plan',
      tasks: [{ id, title: id, tier: 'T1', risk: 'low', allowedPaths: ['src/**'], acceptance: ['ok'] }],
    })}</devloop_result>`
    expect(() => parseDevloopResult(`${result('T-1')} middle ${result('T-2')}`)).toThrow('multiple')
    expect(parseDevloopResult(result('T-1'))).toMatchObject({ kind: 'plan', tasks: [{ id: 'T-1' }] })
  })

  it('requires a full SHA and known review verdict', () => {
    expect(() => validateDevloopResult({
      version: 1,
      kind: 'review',
      taskId: 'a',
      reviewedSha: 'abc',
      verdict: 'PASS',
    })).toThrow('full git SHA')
    expect(() => validateDevloopResult({
      version: 1,
      kind: 'review',
      taskId: 'a',
      reviewedSha: 'a'.repeat(40),
      verdict: 'SHIP',
    })).toThrow('verdict')
  })
})
