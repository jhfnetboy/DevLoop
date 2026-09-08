import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scrubbedEnvNames } from '../src/forge.ts'
import { defaultRunner, quoteForWinCmd, spawnFireAndForget, winCmdCArgument, winCmdSpawnArgs, SIGKILL_GRACE_MS } from '../src/spawn.ts'

describe('quoteForWinCmd', () => {
  it('doubles quotes and always wraps so cmd metacharacters stay inside one token', () => {
    expect(quoteForWinCmd('simple')).toBe('"simple"')
    expect(quoteForWinCmd('a"b&calc')).toBe('"a""b&calc"')
    expect(quoteForWinCmd('100%')).toBe('"100^%"')
    expect(quoteForWinCmd('a"b&calc')).not.toContain('\\"')
    expect(quoteForWinCmd('hello\\')).toBe('"hello\\\\"')
    expect(quoteForWinCmd('a\\"b')).toBe('"a\\\\""b"')
  })

  it('wraps the full /c string so cmd /s strips only the outer quotes', () => {
    const inner = `${quoteForWinCmd('codex')} ${quoteForWinCmd('exec')} ${quoteForWinCmd('a"b&c')}`
    const wrapped = winCmdCArgument('codex', ['exec', 'a"b&c'])
    expect(wrapped).toBe(`"${inner}"`)
    expect(wrapped.slice(1, -1)).toBe(inner)
  })

  it('disables cmd AutoRun and delayed expansion', () => {
    expect(winCmdSpawnArgs('codex', ['exec'])).toEqual([
      '/d',
      '/v:off',
      '/s',
      '/c',
      winCmdCArgument('codex', ['exec']),
    ])
  })
})

describe('spawnFireAndForget', () => {
  it('does not raise uncaughtException when the binary is missing', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => {
      uncaught.push(error)
    }
    process.on('uncaughtException', onUncaught)
    try {
      spawnFireAndForget('devloop-no-such-taskkill-bin', ['/pid', '1'])
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
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

  it('counts maxBuffer in UTF-8 bytes, not JS string length', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-cjk-'))
    const cap = 100
    try {
      await defaultRunner({
        command: process.execPath,
        argv: ['-e', 'process.stdout.write("你".repeat(50)); setInterval(() => {}, 1e9)'],
        cwd,
        timeoutMs: 8_000,
        maxBuffer: cap,
      })
      throw new Error('expected overflow')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      expect(message).toMatch(/spawn output exceeded maxBuffer/)
      const captured = Number(/maxBuffer \((\d+)\)/.exec(message)?.[1])
      expect(captured).toBeGreaterThan(cap)
    }
  }, 8_000)

  it('rejects after SIGKILL grace when the child ignores SIGTERM', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'devloop-hang-'))
    const script = fileURLToPath(new URL('./fixtures/hang.mjs', import.meta.url))
    const abort = new AbortController()
    const started = Date.now()
    const run = defaultRunner({
      command: process.execPath,
      argv: [script],
      cwd,
      timeoutMs: 30_000,
      signal: abort.signal,
    })
    abort.abort()
    await expect(run).rejects.toThrow(/backend timeout/)
    expect(Date.now() - started).toBeLessThan(SIGKILL_GRACE_MS * 2 + 1_500)
  }, 8_000)
})

describe('defaultRunner environment', () => {
  const script = fileURLToPath(new URL('./fixtures/echo-env.mjs', import.meta.url))

  it('layers overrides on top of the inherited environment instead of replacing it', async () => {
    process.env.DEVLOOP_SPAWN_INHERITED = 'kept'
    try {
      const { stdout } = await defaultRunner({
        command: process.execPath,
        argv: [script, 'DEVLOOP_SPAWN_INHERITED', 'GIT_TERMINAL_PROMPT', 'PATH'],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        env: { GIT_TERMINAL_PROMPT: '0' },
      })
      const seen = JSON.parse(stdout)
      expect(seen.GIT_TERMINAL_PROMPT).toBe('0')
      // Inherited entries the child still needs must survive the override.
      expect(seen.DEVLOOP_SPAWN_INHERITED).toBe('kept')
      expect(seen.PATH).toBeTruthy()
    } finally {
      delete process.env.DEVLOOP_SPAWN_INHERITED
    }
  })

  it('lets an override blank out an inherited entry', async () => {
    process.env.DEVLOOP_SPAWN_OVERRIDDEN = 'original'
    try {
      const { stdout } = await defaultRunner({
        command: process.execPath,
        argv: [script, 'DEVLOOP_SPAWN_OVERRIDDEN'],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        env: { DEVLOOP_SPAWN_OVERRIDDEN: '' },
      })
      expect(JSON.parse(stdout).DEVLOOP_SPAWN_OVERRIDDEN).toBe('')
    } finally {
      delete process.env.DEVLOOP_SPAWN_OVERRIDDEN
    }
  })

  it('inherits the environment unchanged when no override is given', async () => {
    process.env.DEVLOOP_SPAWN_PLAIN = 'inherited'
    try {
      const { stdout } = await defaultRunner({
        command: process.execPath,
        argv: [script, 'DEVLOOP_SPAWN_PLAIN'],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      })
      expect(JSON.parse(stdout).DEVLOOP_SPAWN_PLAIN).toBe('inherited')
    } finally {
      delete process.env.DEVLOOP_SPAWN_PLAIN
    }
  })

  it('keeps git config injected through GIT_CONFIG_PARAMETERS away from the child', async () => {
    // Git honours this even in a repository with no config of its own, so a
    // value inherited from this process must not reach a forge child.
    process.env.GIT_CONFIG_PARAMETERS = "'credential.helper=!touch /tmp/devloop-pwned'"
    try {
      const script = fileURLToPath(new URL('./fixtures/echo-env.mjs', import.meta.url))
      const { stdout } = await defaultRunner({
        command: process.execPath,
        argv: [script, 'GIT_CONFIG_PARAMETERS'],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        unsetEnv: scrubbedEnvNames(),
      })
      expect(JSON.parse(stdout).GIT_CONFIG_PARAMETERS).toBeNull()
    } finally {
      delete process.env.GIT_CONFIG_PARAMETERS
    }
  })

  it('removes named inherited entries before applying overrides', async () => {
    process.env.DEVLOOP_SPAWN_HOSTILE = 'present'
    try {
      const script = fileURLToPath(new URL('./fixtures/echo-env.mjs', import.meta.url))
      const { stdout } = await defaultRunner({
        command: process.execPath,
        argv: [script, 'DEVLOOP_SPAWN_HOSTILE', 'PATH'],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        unsetEnv: ['DEVLOOP_SPAWN_HOSTILE'],
      })
      const seen = JSON.parse(stdout)
      expect(seen.DEVLOOP_SPAWN_HOSTILE).toBeNull()
      // Unsetting one name must not strip the rest of the environment.
      expect(seen.PATH).toBeTruthy()
    } finally {
      delete process.env.DEVLOOP_SPAWN_HOSTILE
    }
  })
})
