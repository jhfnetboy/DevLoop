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

  it('keeps a task\'s size estimate, and drops a malformed one without failing the plan', () => {
    const task = { id: 'T-1', title: 't', tier: 'T1', risk: 'low', allowedPaths: ['src/**'], acceptance: ['tests pass'] }
    const plan = (estimate: unknown) => validateDevloopResult({ version: 1, kind: 'plan', tasks: [{ ...task, estimate }] })
    expect(plan({ lines: 120, files: 3 })).toMatchObject({ tasks: [{ estimate: { lines: 120, files: 3 } }] })
    for (const bad of [undefined, 'small', { lines: 120 }, { lines: -1, files: 1 }, { lines: 1.5, files: 1 }, { lines: 2_000_000, files: 1 }]) {
      const result = plan(bad)
      expect(result.kind === 'plan' && 'estimate' in result.tasks[0]!).toBe(false)
    }
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

  it('cuts a review\'s long notes instead of refusing the verdict, and takes empty notes as none', () => {
    const review = (notes: unknown) => validateDevloopResult({ version: 1, kind: 'review', taskId: 'T-1', reviewedSha: 'a'.repeat(40), verdict: 'REWORK', notes })
    const long = review('x'.repeat(20_000))
    expect(long.kind === 'review' && long.verdict).toBe('REWORK')
    const notes = long.kind === 'review' ? long.notes ?? '' : ''
    // Within what a task's saved review notes may hold, so the rework reaches the worker.
    expect(notes.length).toBe(8_192)
    expect(notes.endsWith('\n[truncated]')).toBe(true)
    // A cut that would fall inside an emoji keeps the whole character or none of it.
    const emoji = review(`${'x'.repeat(8_179)}${'😀'.repeat(10)}`)
    const cut = emoji.kind === 'review' ? emoji.notes ?? '' : ''
    expect(cut.endsWith('x\n[truncated]')).toBe(true)
    expect(cut.isWellFormed()).toBe(true)
    expect(review('  keep this  ')).toMatchObject({ notes: 'keep this' })
    expect('notes' in review('   ')).toBe(false)
    expect(() => review('a\0b')).toThrow(/NUL/)
    expect(() => review(42)).toThrow(/must be a string/)
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
