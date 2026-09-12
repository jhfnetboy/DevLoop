import type { LoopState } from './types.js'

/**
 * Which column of the home page a project belongs in: the first thing an
 * operator wants from the page is what needs them, kept apart from what is
 * moving, what is parked and what is finished.
 */
export type AttentionLane = 'needs_you' | 'running' | 'idle' | 'done'

export interface AttentionInput {
  /** The page could not read the project. */
  readonly error: boolean
  readonly armed: boolean
  readonly completed: boolean
  readonly halted: boolean
  readonly loop: 'running' | 'stopped' | 'elsewhere'
  readonly state: Pick<LoopState, 'paused' | 'acknowledged' | 'updatedAt'> | null
}

export interface Attention {
  readonly lane: AttentionLane
  /** Since when it has been in that lane, when that is known; the page shows it as an age. */
  readonly since: string | null
}

export function attentionFor(input: AttentionInput): Attention {
  if (input.error) return { lane: 'needs_you', since: null }
  if (!input.armed) return { lane: 'idle', since: null }
  if (input.completed) return { lane: 'done', since: input.state?.updatedAt ?? null }
  // Parked by a person: a pause, or an answer of "leave it" to a halt. Neither asks anything more.
  if (input.state?.paused) return { lane: 'idle', since: input.state.paused.at }
  if (input.halted && input.state?.acknowledged) return { lane: 'idle', since: input.state.acknowledged.at }
  // A halted loop writes nothing more, so its last write is when it stopped.
  if (input.halted) return { lane: 'needs_you', since: input.state?.updatedAt ?? null }
  // Armed and not halted, but the process meant to run it has stopped: nothing will move by itself.
  if (input.loop === 'stopped') return { lane: 'needs_you', since: null }
  return { lane: 'running', since: null }
}
