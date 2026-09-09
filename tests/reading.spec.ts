import { describe, expect, it } from 'vitest'
import { readClaudeJson, readCodexJsonl, readPlainOutput } from '../src/reading.ts'

/** Shapes copied from real runs of the installed CLIs, trimmed to what is read. */
const CLAUDE_JSON = JSON.stringify({
  type: 'result',
  result: 'PONG\n<devloop_result>{"version":1,"kind":"plan","tasks":[]}</devloop_result>',
  total_cost_usd: 0.251395,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 25126,
    cache_read_input_tokens: 100,
    output_tokens: 5,
  },
})

const CODEX_JSONL = [
  '{"type":"thread.started"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
  '{"type":"turn.completed","usage":{"input_tokens":19098,"cached_input_tokens":11136,"output_tokens":6}}',
].join('\n')

describe('readClaudeJson', () => {
  it('unwraps the reply and reports both counters', () => {
    const reading = readClaudeJson(CLAUDE_JSON)
    expect(reading.text).toContain('<devloop_result>')
    expect(reading.text.startsWith('PONG')).toBe(true)
    expect(reading.costUsd).toBe(0.251395)
    // Everything read plus everything written: 2 + 25126 + 100 + 5.
    expect(reading.tokens).toBe(25233)
  })

  it('keeps the answer when the envelope is missing or malformed', () => {
    // Losing a cost signal beats losing the model's reply.
    expect(readClaudeJson('plain prose').text).toBe('plain prose')
    expect(readClaudeJson('{ not json').text).toBe('{ not json')
    expect(readClaudeJson('{"total_cost_usd":1}').text).toBe('{"total_cost_usd":1}')
    expect(readClaudeJson('plain prose').costUsd).toBeUndefined()
  })

  it('leaves a counter out rather than reporting zero', () => {
    // A zero folds into the budget as "this run was free", which is a lie.
    const noUsage = readClaudeJson(JSON.stringify({ result: 'hi', total_cost_usd: 0 }))
    expect(noUsage.tokens).toBeUndefined()
    expect(noUsage.costUsd).toBeUndefined()
    const bad = readClaudeJson(JSON.stringify({ result: 'hi', usage: { input_tokens: 'lots' } }))
    expect(bad.tokens).toBeUndefined()
  })
})

describe('readCodexJsonl', () => {
  it('takes the last agent message and the reported tokens', () => {
    const reading = readCodexJsonl(CODEX_JSONL)
    expect(reading.text).toBe('PONG')
    // cached_input_tokens is part of input_tokens, so counting it would double.
    expect(reading.tokens).toBe(19104)
  })

  it('reports no cost, because codex reports none', () => {
    // Inventing one would spend a real budget on a guess.
    expect(readCodexJsonl(CODEX_JSONL).costUsd).toBeUndefined()
  })

  it('prefers the newest message and sums turns', () => {
    const twoTurns = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
      '{"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":2}}',
    ].join('\n')
    expect(readCodexJsonl(twoTurns)).toEqual({ text: 'second', tokens: 33 })
  })

  it('falls back to the raw output when no message can be recognised', () => {
    const noisy = 'error: not inside a trusted directory\n'
    expect(readCodexJsonl(noisy).text).toBe(noisy)
    expect(readCodexJsonl(noisy).tokens).toBeUndefined()
  })

  it('ignores lines it cannot parse instead of failing the run', () => {
    const mixed = `warning: something\n${CODEX_JSONL}\ntrailing noise`
    expect(readCodexJsonl(mixed).text).toBe('PONG')
  })
})

describe('readPlainOutput', () => {
  it('reports prose and nothing else', () => {
    // dsh --profile headless has no output options at all, so there is nothing
    // to read: claiming otherwise would put a fabricated number in the budget.
    expect(readPlainOutput('PONG')).toEqual({ text: 'PONG' })
  })
})
