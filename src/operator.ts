import type { BudgetLimits } from './config.js'
import { applyAnswer, gateFor, type Gate, type GateOption } from './gate.js'
import { loadState, saveState, withStateLock } from './persist.js'
import { writeProgress } from './progress.js'
import { diagnoseHalt, integrityHold, resumeState, type HaltDiagnosis, type ResumeOptions } from './resume.js'
import type { LoopState, Pause } from './types.js'

/**
 * What an operator can do to a loop, from any surface.
 *
 * The CLI and the dashboard both call these, so a button on the page is the
 * same code under the same lock as the command it stands for — not a second
 * implementation that can drift, and not a way to write STATE.json that the
 * CLI does not have.
 */
export type OperatorSurface = Pause['via']

export interface OperatorOptions {
  readonly via: OperatorSurface
  /**
   * The revision the operator was looking at when they decided. When given,
   * the write is refused if the state has moved on: an answer is to a question,
   * and a question that was replaced while the page sat open is not the one
   * they answered.
   */
  readonly expectedRevision?: number
  readonly now?: () => number
}

export type OperatorFailure = 'busy' | 'stale' | 'refused'

export class OperatorError extends Error {
  constructor(readonly code: OperatorFailure, message: string) {
    super(message)
    this.name = 'OperatorError'
  }
}

export interface OperatorOutcome {
  readonly saved: LoopState
  /** What would stop the loop again on its next tick, if anything. */
  readonly stillBlocked: string | null
  /** PROGRESS.md is derived and best-effort; STATE is already committed either way. */
  readonly progressWritten: boolean
}

export interface AnswerOutcome extends OperatorOutcome {
  readonly gate: Gate
  readonly choice: GateOption['key']
  /** `stop` lifts nothing on purpose: it is the answer, not a failure to recover. */
  readonly declined: boolean
}

export interface ResumeOutcome extends OperatorOutcome {
  /** The halt as it stood before the resume, so a surface can say what it cleared. */
  readonly before: HaltDiagnosis
}

/** Label a journal entry so a change made from another device can be told apart. */
function label(action: string, via: OperatorSurface): string {
  return via === 'cli' ? action : `${action}@${via}`
}

async function underLock<T>(
  root: string,
  options: OperatorOptions,
  body: (current: LoopState, now: number) => Promise<T>,
): Promise<T> {
  const clock = options.now ?? Date.now
  const outcome = await withStateLock(root, async () => {
    const now = clock()
    const current = await loadState(root, now)
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw new OperatorError(
        'stale',
        `the loop moved on (revision ${current.revision}, you saw ${options.expectedRevision}); look again before deciding`,
      )
    }
    return body(current, now)
  })
  if (!outcome.ok) {
    throw new OperatorError('busy', 'another process holds the state lock; stop the profile and retry')
  }
  return outcome.value
}

async function progress(root: string, state: LoopState, now: number): Promise<boolean> {
  try {
    await writeProgress(root, state, now)
    return true
  } catch {
    return false
  }
}

export async function answerGate(
  root: string,
  choice: GateOption['key'],
  limits: BudgetLimits,
  options: OperatorOptions,
): Promise<AnswerOutcome> {
  return underLock(root, options, async (current, now) => {
    const gate = gateFor(current, limits, now)
    if (gate === null) throw new OperatorError('refused', 'answer: the loop is not waiting on anything')
    let next: LoopState
    try {
      next = applyAnswer(current, gate, choice, now)
    } catch (error) {
      throw new OperatorError('refused', error instanceof Error ? error.message : String(error))
    }
    const saved = await saveState(root, next, {
      expectedRevision: current.revision,
      action: label(`answer:${choice}`, options.via),
    })
    return {
      saved,
      gate,
      choice,
      declined: choice === 'stop',
      stillBlocked: diagnoseHalt(saved, limits, now).wouldHaltAgain,
      progressWritten: await progress(root, saved, now),
    }
  })
}

export async function resumeLoop(
  root: string,
  resume: ResumeOptions,
  limits: BudgetLimits,
  options: OperatorOptions,
): Promise<ResumeOutcome> {
  return underLock(root, options, async (current, now) => {
    // resumeState refuses an integrity hold; a synthesised empty state must
    // never be written over a STATE.json that merely failed to parse.
    const before = diagnoseHalt(current, limits, now, resume)
    let next: LoopState
    try {
      next = resumeState(current, resume, now)
    } catch (error) {
      throw new OperatorError('refused', error instanceof Error ? error.message : String(error))
    }
    const saved = await saveState(root, next, { expectedRevision: current.revision, action: label('resume', options.via) })
    return {
      saved,
      before,
      stillBlocked: diagnoseHalt(saved, limits, now).wouldHaltAgain,
      progressWritten: await progress(root, saved, now),
    }
  })
}

/**
 * Stop a loop that is running fine.
 *
 * Only a loop that is not already halted can be paused: pausing a halt would
 * bury the question it is asking under a pause with none. `killSwitch` does the
 * stopping, through every path that already honours it; `paused` says it was a
 * person, which is what lets resume be the whole answer.
 */
export async function pauseLoop(
  root: string,
  limits: BudgetLimits,
  options: OperatorOptions,
): Promise<OperatorOutcome> {
  return underLock(root, options, async (current, now) => {
    const integrity = integrityHold(current)
    if (integrity !== null) throw new OperatorError('refused', `pause: refusing to write over a ${integrity} hold`)
    const diagnosis = diagnoseHalt(current, limits, now)
    if (diagnosis.halted) {
      throw new OperatorError('refused', `pause: the loop is already halted (${diagnosis.reasons[0] ?? 'stopped'})`)
    }
    const next: LoopState = {
      ...current,
      killSwitch: true,
      lastAction: { type: 'stop', reason: 'kill_switch' },
      paused: { at: new Date(now).toISOString(), via: options.via },
      updatedAt: new Date(now).toISOString(),
    }
    const saved = await saveState(root, next, { expectedRevision: current.revision, action: label('pause', options.via) })
    return {
      saved,
      stillBlocked: diagnoseHalt(saved, limits, now).wouldHaltAgain,
      progressWritten: await progress(root, saved, now),
    }
  })
}
