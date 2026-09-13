import type { LoopState } from './types.js'

/**
 * A project is one repository worked on goal after goal. A finished goal does
 * not end the project: the next goal starts from the same work branch.
 */
export function goalNumber(state: LoopState): number {
  return state.goal?.number ?? 1
}

/**
 * The state the next goal starts from. Pure. Refuses unless the current goal
 * is finished with nothing running and nothing held, and, when the forge
 * merges, its release pull request has merged: the next release must carry
 * only the next goal's work.
 *
 * Spend carries over — a new goal is not a way round a cost cap — while the
 * per-task counters start again, since the next plan's tasks are new ones.
 */
export function nextGoalState(state: LoopState, now: number, requireRelease: boolean): LoopState {
  if (!state.goalCompleted) throw new Error('next_goal: the current goal is not finished')
  if (state.supervisor !== null) throw new Error('next_goal: the loop is held; answer it first')
  if (state.tasks.some(task => task.status !== 'done')) throw new Error('next_goal: not every task is done')
  if (state.usage.parallelWorkers > 0) throw new Error('next_goal: a worker is still running')
  if (requireRelease && state.release?.merged !== true) {
    throw new Error('next_goal: the release pull request has not merged yet; the next goal starts after it')
  }
  const at = new Date(now).toISOString()
  const { acknowledged: _acknowledged, paused: _paused, release: _release, ...rest } = state
  return {
    ...rest,
    goal: { number: goalNumber(state) + 1, startedAt: at },
    goalCompleted: false,
    killSwitch: false,
    supervisor: null,
    tasks: [],
    lastAction: { type: 'idle' },
    lastDispatchStatus: null,
    usage: {
      ...state.usage,
      taskAttempts: {},
      refusedDispatches: {},
      reviewCycles: {},
      taskStartedAt: {},
      tokens: {},
      lastActions: [],
      lastProgressAt: now,
    },
    updatedAt: at,
  }
}
