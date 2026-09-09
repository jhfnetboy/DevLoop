import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertAcceptanceChecks, runAcceptanceChecks } from '../src/acceptance.ts'
import { resolveConfig } from '../src/config.ts'
import { gateFor } from '../src/gate.ts'
import type { HeadlessRun, HeadlessRunner } from '../src/spawn.ts'
import type { LoopState } from '../src/types.ts'
import { baseState, makeTask, mkdtempInRepo, withTasks } from './helpers.ts'

const limits = resolveConfig({}).budget

describe('assertAcceptanceChecks', () => {
  it('accepts argv lists and nothing that could turn into a shell', () => {
    expect(() => assertAcceptanceChecks([['pnpm', 'test'], ['pnpm', 'build']])).not.toThrow()
    expect(() => assertAcceptanceChecks([[]])).toThrow(/non-empty argv/)
    expect(() => assertAcceptanceChecks(['pnpm test' as never])).toThrow(/non-empty argv/)
    expect(() => assertAcceptanceChecks([['', 'test']])).toThrow(/non-empty strings/)
    expect(() => assertAcceptanceChecks([['--version']])).toThrow(/is not a command/)
  })

  it('is empty by default, so nothing runs until an operator asks', () => {
    expect(resolveConfig({}).acceptance).toEqual([])
  })

  it('is validated when the config is resolved, not when a task finishes', () => {
    // A malformed check should fail at startup, not halfway through a run.
    expect(() => resolveConfig({ acceptance: [['-rf']] })).toThrow(/is not a command/)
  })
})

describe('runAcceptanceChecks', () => {
  const scratch: string[] = []
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('reports nothing when there is nothing to run', async () => {
    expect(await runAcceptanceChecks('/nowhere', [], 1_000)).toBeNull()
  })

  it('runs each check in the task worktree, as argv, with no shell', async () => {
    const calls: HeadlessRun[] = []
    const runner: HeadlessRunner = async request => {
      calls.push(request)
      return { stdout: '', stderr: '' }
    }
    const failure = await runAcceptanceChecks('/repo/.devloop/worktrees/A', [['pnpm', 'test'], ['pnpm', 'build']], 5_000, undefined, runner)
    expect(failure).toBeNull()
    expect(calls.map(c => [c.command, ...c.argv])).toEqual([['pnpm', 'test'], ['pnpm', 'build']])
    expect(calls.every(c => c.cwd === '/repo/.devloop/worktrees/A')).toBe(true)
  })

  it('stops at the first failure and names the command that failed', async () => {
    const calls: HeadlessRun[] = []
    const runner: HeadlessRunner = async request => {
      calls.push(request)
      if (request.argv.includes('test')) throw new Error('exit 1')
      return { stdout: '', stderr: '' }
    }
    const failure = await runAcceptanceChecks('/w', [['pnpm', 'test'], ['pnpm', 'build']], 5_000, undefined, runner)
    expect(failure?.argv).toEqual(['pnpm', 'test'])
    expect(failure?.detail).toContain('exit 1')
    // The build never ran: the task is going back either way.
    expect(calls).toHaveLength(1)
  })

  it('keeps a hold reason readable when a suite prints a wall of output', async () => {
    const runner: HeadlessRunner = async () => { throw new Error('x'.repeat(50_000)) }
    const failure = await runAcceptanceChecks('/w', [['noisy']], 5_000, undefined, runner)
    expect(failure!.detail.length).toBeLessThan(4_100)
    expect(failure!.detail.endsWith('…')).toBe(true)
  })

  it('really runs the command, and really notices a non-zero exit', async () => {
    // The stub above proves the wiring; this proves the thing it stands for.
    const root = await mkdtempInRepo('devloop-accept-')
    scratch.push(root)
    const good = join(root, 'good.sh')
    const bad = join(root, 'bad.sh')
    await writeFile(good, '#!/bin/sh\nexit 0\n', 'utf8')
    await writeFile(bad, '#!/bin/sh\necho "the suite failed" >&2\nexit 1\n', 'utf8')
    await chmod(good, 0o755)
    await chmod(bad, 0o755)

    expect(await runAcceptanceChecks(root, [[good]], 20_000)).toBeNull()
    const failure = await runAcceptanceChecks(root, [[good], [bad]], 20_000)
    expect(failure?.argv).toEqual([bad])
  })
})

describe('a failed check becomes a question', () => {
  it('says which command failed and where to run it by hand', () => {
    const state: LoopState = {
      ...withTasks(baseState(), [makeTask({ id: 'A', status: 'rework' })]),
      killSwitch: true,
      lastAction: { type: 'stop', reason: 'budget' },
      supervisor: { taskId: 'A', reason: 'acceptance_failed: pnpm test' },
    }
    const gate = gateFor(state, limits, 1_000)
    expect(gate?.question).toMatch(/did not pass the checks/i)
    expect(gate?.evidence.join(' ')).toContain('pnpm test')
    expect(gate?.evidence.join(' ')).toContain('never offered for review')
    expect(gate?.options.map(o => o.key)).toEqual(['retry', 'stop'])
    expect(gate?.manual).toContain('.devloop/worktrees/')
  })
})
