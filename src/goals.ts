import { copyFile, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OperatorError } from './operator.js'
import { devloopDir, loadState, saveState, withStateLock } from './persist.js'
import { MAX_GOAL_BYTES } from './projects.js'
import type { LoopState } from './types.js'

/**
 * A project is one repository worked on goal after goal. A finished goal does
 * not end the project: it is archived, and the next goal starts from the same
 * work branch with its history kept under `.devloop/archive/NNNN/`.
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

export const ARCHIVE_DIR = 'archive'

/** What a goal leaves behind that belongs to it alone; EVENTS and PR-LOG stay one continuous record. */
const ARCHIVED_FILES = ['GOAL.md', 'STATE.json', 'PLAN.md', 'REVIEW.md', 'PROGRESS.md'] as const
/** Written for the goal that just finished; the next one writes its own. */
const CLEARED_FILES = ['PLAN.md', 'REVIEW.md'] as const

export interface NextGoalOptions {
  /** The revision the operator saw; a loop that moved on since is refused. */
  readonly expectedRevision?: number
  readonly requireRelease: boolean
  readonly via: 'cli' | 'dashboard'
  readonly now?: () => number
}

/**
 * Archive the finished goal and start the next one, under the state lock.
 * Copies first and saves STATE last: if this stops part way, STATE still says
 * the goal is finished, so the loop stays stopped and the same call can be
 * made again.
 */
export async function startNextGoal(root: string, goal: string, options: NextGoalOptions): Promise<LoopState> {
  const text = goal.trim()
  if (text === '') throw new OperatorError('refused', 'the goal is empty')
  if (Buffer.byteLength(text) > MAX_GOAL_BYTES) throw new OperatorError('refused', `the goal is over ${MAX_GOAL_BYTES} bytes`)
  const clock = options.now ?? Date.now
  const outcome = await withStateLock(root, async () => {
    const now = clock()
    const current = await loadState(root, now)
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw new OperatorError('stale', `the loop moved on (revision ${current.revision}, you saw ${options.expectedRevision}); look again before deciding`)
    }
    let next: LoopState
    try {
      next = nextGoalState(current, now, options.requireRelease)
    } catch (error) {
      throw new OperatorError('refused', error instanceof Error ? error.message : String(error))
    }
    const dir = devloopDir(root)
    await archiveGoal(dir, goalNumber(current))
    const staged = join(dir, 'GOAL.md.next')
    await rm(staged, { force: true })
    // Exclusive: a path planted there, symlink or not, is refused rather than written through.
    await writeFile(staged, `${text}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 })
    await rename(staged, join(dir, 'GOAL.md'))
    for (const name of CLEARED_FILES) await rm(join(dir, name), { force: true })
    return saveState(root, next, { expectedRevision: current.revision, action: options.via === 'cli' ? 'next-goal' : `next-goal@${options.via}` })
  })
  if (!outcome.ok) throw new OperatorError('busy', 'another process holds the state lock; stop the profile and retry')
  return outcome.value
}

/**
 * `.devloop/archive/NNNN/`, written whole or not at all, and never overwritten.
 * One already there for this goal is from a call that stopped before STATE was
 * saved (the goal is still the current one), so it is kept and the call goes on.
 */
async function archiveGoal(dir: string, number: number): Promise<void> {
  const archive = join(dir, ARCHIVE_DIR)
  await mkdir(archive, { recursive: true })
  if ((await lstat(archive)).isSymbolicLink()) throw new OperatorError('refused', '.devloop/archive must be a real directory')
  const name = String(number).padStart(4, '0')
  const target = join(archive, name)
  if (await exists(target)) return
  const staging = join(archive, `${name}.tmp`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging)
  for (const file of ARCHIVED_FILES) {
    const from = join(dir, file)
    if (!await exists(from)) continue
    if ((await lstat(from)).isSymbolicLink()) throw new OperatorError('refused', `refusing to archive a symlinked .devloop/${file}`)
    await copyFile(from, join(staging, file))
  }
  await rename(staging, target)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
