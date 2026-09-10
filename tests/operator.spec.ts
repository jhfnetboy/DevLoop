import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/command.ts'
import { resolveConfig } from '../src/config.ts'
import { gateFor } from '../src/gate.ts'
import { answerGate, OperatorError, pauseLoop, resumeLoop } from '../src/operator.ts'
import { emptyState, loadState, saveState, statePath } from '../src/persist.ts'
import { diagnoseHalt } from '../src/resume.ts'
import type { LoopState } from '../src/types.ts'
import { makeTask, mkdtempInRepo } from './helpers.ts'

const limits = resolveConfig({}).budget

async function armed(state: LoopState): Promise<string> {
  const root = await mkdtempInRepo('devloop-operator-')
  await mkdir(join(root, '.devloop'))
  await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
  await saveState(root, state)
  return root
}

function running(): LoopState {
  return { ...emptyState(Date.now()), lastAction: { type: 'plan' }, tasks: [makeTask({ id: 'A', status: 'ready' })] }
}

async function journal(root: string): Promise<string[]> {
  return (await readFile(join(root, '.devloop', 'EVENTS.jsonl'), 'utf8'))
    .split('\n').filter(line => line.trim() !== '')
    .map(line => (JSON.parse(line) as { action: string }).action)
}

describe('pause', () => {
  it('stops a healthy loop through killSwitch, and says it was a person', async () => {
    const root = await armed(running())
    const outcome = await pauseLoop(root, limits, { via: 'dashboard' })
    const state = await loadState(root, Date.now())
    expect(state.killSwitch).toBe(true)
    expect(state.lastAction).toEqual({ type: 'stop', reason: 'kill_switch' })
    expect(state.paused?.via).toBe('dashboard')
    expect(outcome.saved.revision).toBe(state.revision)
    // The journal tells a remote pause from a local one.
    expect((await journal(root)).at(-1)).toBe('pause@dashboard')
  })

  it('asks no question — resume is the whole answer — and names itself as the reason', async () => {
    const root = await armed(running())
    await pauseLoop(root, limits, { via: 'cli' })
    const state = await loadState(root, Date.now())
    expect(gateFor(state, limits, Date.now())).toBeNull()
    const diagnosis = diagnoseHalt(state, limits, Date.now())
    expect(diagnosis.halted).toBe(true)
    expect(diagnosis.reasons[0]).toMatch(/^paused by an operator \(cli\)/)
    expect(diagnosis.wouldHaltAgain).toBeNull()
  })

  it('refuses to bury a halt that is already asking something', async () => {
    const root = await armed({
      ...running(),
      killSwitch: true,
      supervisor: { taskId: 'A', reason: 'empty_task' },
      lastAction: { type: 'stop', reason: 'blocked' },
    })
    await expect(pauseLoop(root, limits, { via: 'dashboard' })).rejects.toMatchObject({ code: 'refused' })
    expect((await loadState(root, Date.now())).paused).toBeUndefined()
  })

  it('is lifted by resume, which leaves no trace of it', async () => {
    const root = await armed(running())
    await pauseLoop(root, limits, { via: 'dashboard' })
    const outcome = await resumeLoop(root, {}, limits, { via: 'dashboard' })
    const state = await loadState(root, Date.now())
    expect(state.killSwitch).toBe(false)
    expect(state.paused).toBeUndefined()
    expect(outcome.stillBlocked).toBeNull()
    expect(outcome.before.reasons[0]).toMatch(/paused by an operator/)
    expect((await journal(root)).slice(-2)).toEqual(['pause@dashboard', 'resume@dashboard'])
  })

  it('degrades a malformed pause record to none, and keeps the halt', async () => {
    const root = await armed(running())
    await pauseLoop(root, limits, { via: 'cli' })
    const file = statePath(root)
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    await writeFile(file, JSON.stringify({ ...raw, paused: { at: 12, via: 'nobody' } }), 'utf8')
    const state = await loadState(root, Date.now())
    expect(state.paused).toBeUndefined()
    expect(state.killSwitch).toBe(true)
    expect(state.supervisor).toBeNull()
  })
})

describe('the revision a decision was made against', () => {
  it('refuses an answer to a question that has since changed', async () => {
    const root = await armed({
      ...running(),
      killSwitch: true,
      supervisor: { taskId: 'A', reason: 'empty_task' },
      lastAction: { type: 'stop', reason: 'blocked' },
    })
    const seen = (await loadState(root, Date.now())).revision
    // Someone else answers first.
    await answerGate(root, 'stop', limits, { via: 'cli' })
    const late = answerGate(root, 'retry', limits, { via: 'dashboard', expectedRevision: seen })
    await expect(late).rejects.toBeInstanceOf(OperatorError)
    await expect(late).rejects.toMatchObject({ code: 'stale' })
    expect((await journal(root)).at(-1)).toBe('answer:stop')
  })

  it('applies the answer when nothing moved', async () => {
    const root = await armed({
      ...running(),
      killSwitch: true,
      supervisor: { taskId: 'A', reason: 'empty_task' },
      lastAction: { type: 'stop', reason: 'blocked' },
    })
    const seen = (await loadState(root, Date.now())).revision
    const outcome = await answerGate(root, 'retry', limits, { via: 'dashboard', expectedRevision: seen })
    expect(outcome.saved.revision).toBe(seen + 1)
    expect(outcome.declined).toBe(false)
    expect((await journal(root)).at(-1)).toBe('answer:retry@dashboard')
  })
})

describe('devloop pause', () => {
  it('pauses, says how to resume, and status reports it as the reason', async () => {
    const root = await armed(running())
    const paused = await runCli(['pause', root], { invokedAs: 'devloop' })
    expect(paused.code).toBe(0)
    expect(paused.out).toContain('paused at revision')
    expect(paused.out).toContain(`devloop resume ${root}`)

    const status = await runCli(['status', root], { invokedAs: 'devloop' })
    expect(status.code).toBe(1)
    expect(status.out).toContain('paused by an operator (cli)')

    const again = await runCli(['pause', root], { invokedAs: 'devloop' })
    expect(again.code).toBe(1)
    expect(again.err).toContain('already halted')

    const resumed = await runCli(['resume', root], { invokedAs: 'devloop' })
    expect(resumed.code).toBe(0)
    expect(resumed.out).toContain('cleared: paused by an operator')
  })
})
