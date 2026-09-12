import { describe, expect, it } from 'vitest'
import { attentionFor, type AttentionInput } from '../src/attention.ts'

const at = '2026-09-12T10:00:00.000Z'
const live: AttentionInput = { error: false, armed: true, completed: false, halted: false, loop: 'running', state: { updatedAt: at } }

describe('which column of the home page a project is in', () => {
  it.each([
    ['a project the page cannot read', { ...live, error: true }, 'needs_you', null],
    ['a project with no goal yet', { ...live, armed: false, state: null }, 'idle', null],
    ['a finished goal', { ...live, completed: true, halted: true }, 'done', at],
    ['a paused loop, aged from the pause', { ...live, halted: true, state: { updatedAt: at, paused: { at: '2026-09-12T09:00:00.000Z', via: 'dashboard' as const } } }, 'idle', '2026-09-12T09:00:00.000Z'],
    ['a halt the operator chose to leave', { ...live, halted: true, state: { updatedAt: at, acknowledged: { at: '2026-09-12T08:00:00.000Z', reason: 'empty_task', taskId: 't1' } } }, 'idle', '2026-09-12T08:00:00.000Z'],
    ['a halt asking a question, aged from its last write', { ...live, halted: true }, 'needs_you', at],
    ['an armed loop whose process has stopped', { ...live, loop: 'stopped' as const }, 'needs_you', null],
    ['a loop running here', live, 'running', null],
    ['a loop running in another process', { ...live, loop: 'elsewhere' as const }, 'running', null],
  ])('%s', (_case, input, lane, since) => {
    expect(attentionFor(input)).toEqual({ lane, since })
  })
})
