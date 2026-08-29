import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultRunner } from '../src/spawn.ts'

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
