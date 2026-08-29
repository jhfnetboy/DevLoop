import { constants, lstat, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { assertLocalDevloopDir, devloopDir } from './persist.js'
import type { LoopAction, LoopState, Task } from './types.js'

export const PROGRESS_FILE = 'PROGRESS.md'

export function progressPath(root: string): string {
  return join(devloopDir(root), PROGRESS_FILE)
}

/**
 * Human-readable snapshot of the last persisted tick. STATE.json stays
 * authoritative. Best-effort: callers should catch write failures.
 */
export function renderProgress(state: LoopState, now: number): string {
  const counts = countByStatus(state.tasks)
  const lines = [
    '# DevLoop progress',
    '',
    `Updated: ${new Date(now).toISOString()}`,
    '',
    `- lastAction: ${formatAction(state.lastAction)}`,
    `- killSwitch: ${state.killSwitch}`,
    `- supervisor: ${formatSupervisor(state)}`,
    `- costUsdSession: ${state.usage.costUsdSession}`,
    `- costUsdDay: ${state.usage.costUsdDay}`,
    `- lastProgressAt: ${new Date(state.usage.lastProgressAt).toISOString()}`,
    `- tasks: ${state.tasks.length} (${formatCounts(counts)})`,
    '',
  ]
  if (state.tasks.length > 0) {
    lines.push('## Tasks', '')
    for (const task of state.tasks) {
      lines.push(`- ${task.id} ${task.status} ${task.title}`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

export async function writeProgress(root: string, state: LoopState, now: number): Promise<void> {
  await assertLocalDevloopDir(root)
  const file = progressPath(root)
  try {
    const meta = await lstat(file)
    if (meta.isSymbolicLink()) throw new Error('refusing symlink PROGRESS.md')
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  const temp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  let handle
  try {
    handle = await open(temp, flags, 0o644)
  } catch (error) {
    if (isLoop(error)) throw new Error('refusing symlink PROGRESS.md')
    throw error
  }
  try {
    try {
      await handle.writeFile(renderProgress(state, now), 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function formatAction(action: LoopAction): string {
  if (action.type === 'stop') return `stop:${action.reason}`
  if (action.type === 'delegate' || action.type === 'review' || action.type === 'merge') {
    return `${action.type}:${action.taskId}`
  }
  if (action.type === 'escalate') return `escalate:${action.reason}`
  return action.type
}

function formatSupervisor(state: LoopState): string {
  if (!state.supervisor) return 'none'
  return `${state.supervisor.taskId ?? '_'} ${state.supervisor.reason}`
}

function countByStatus(tasks: readonly Task[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1
  }
  return counts
}

function formatCounts(counts: Record<string, number>): string {
  const parts = Object.keys(counts).sort().map(status => `${status} ${counts[status]}`)
  return parts.length > 0 ? parts.join(', ') : 'none'
}

function isLoop(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ELOOP' || error.code === 'EMLINK')
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
