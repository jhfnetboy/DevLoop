import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultRunner, quoteForWinCmd } from '../src/spawn.ts'

describe('quoteForWinCmd', () => {
  it('doubles quotes and always wraps so cmd metacharacters stay inside one token', () => {
    expect(quoteForWinCmd('simple')).toBe('"simple"')
    expect(quoteForWinCmd('a"b&calc')).toBe('"a""b&calc"')
    expect(quoteForWinCmd('100%')).toBe('"100%%"')
    expect(quoteForWinCmd('a"b&calc')).not.toContain('\\"')
  })
})

describe('defaultRunner', () => {
  it('stops buffering once maxBuffer is exceeded', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-spawn-'))
    const script = fileURLToPath(new URL('./fixtures/flood-stdout.mjs', import.meta.url))
    const cap = 8 * 1024
    try {
      await defaultRunner({
        command: process.execPath,
        argv: [script],
        cwd,
        timeoutMs: 10_000,
        maxBuffer: cap,
      })
      throw new Error('expected overflow')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const match = /spawn output exceeded maxBuffer \((\d+)\)/.exec(message)
      expect(match).not.toBeNull()
      const captured = Number(match?.[1])
      expect(captured).toBeGreaterThan(cap)
      expect(captured).toBeLessThan(1024 * 1024)
    }
  }, 8_000)
})
