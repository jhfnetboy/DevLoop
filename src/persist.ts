import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { emptyUsage } from './budget.js'
import type { LoopState } from './types.js'
import { STATE_VERSION } from './types.js'

export const DEVLOOP_DIR = '.devloop'
export const STATE_FILE = 'STATE.json'
export const GOAL_FILE = 'GOAL.md'

export function devloopDir(root: string): string {
  return join(root, DEVLOOP_DIR)
}

export function statePath(root: string): string {
  return join(devloopDir(root), STATE_FILE)
}

export function goalPath(root: string): string {
  return join(devloopDir(root), GOAL_FILE)
}

export async function workspaceArmed(root: string): Promise<boolean> {
  try {
    const dir = await stat(devloopDir(root))
    if (!dir.isDirectory()) return false
    const goal = await stat(goalPath(root))
    return goal.isFile()
  } catch {
    return false
  }
}

export function emptyState(now: number): LoopState {
  return {
    version: STATE_VERSION,
    goalCompleted: false,
    killSwitch: false,
    supervisor: null,
    tasks: [],
    usage: emptyUsage(now),
    lastAction: { type: 'idle' },
    lastDispatchStatus: null,
    updatedAt: new Date(now).toISOString(),
  }
}

export async function loadState(root: string, now: number): Promise<LoopState> {
  try {
    const raw = await readFile(statePath(root), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isLoopState(parsed)) return haltState(now, 'invalid_state')
    return {
      ...parsed,
      lastDispatchStatus: parsed.lastDispatchStatus ?? null,
    }
  } catch (error) {
    if (isNotFound(error)) return emptyState(now)
    return haltState(now, 'unreadable_state')
  }
}

export async function saveState(root: string, state: LoopState): Promise<void> {
  const file = statePath(root)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

function haltState(now: number, reason: string): LoopState {
  return {
    ...emptyState(now),
    killSwitch: true,
    supervisor: { taskId: null, reason },
    lastAction: { type: 'stop', reason: 'kill_switch' },
    updatedAt: new Date(now).toISOString(),
  }
}

function isLoopState(value: unknown): value is LoopState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<LoopState>
  if (record.version !== STATE_VERSION) return false
  if (typeof record.goalCompleted !== 'boolean') return false
  if (typeof record.killSwitch !== 'boolean') return false
  if (!Array.isArray(record.tasks)) return false
  if (!record.tasks.every(isTaskShape)) return false
  if (!isUsageShape(record.usage)) return false
  if (!isActionShape(record.lastAction)) return false
  if (record.supervisor !== null && record.supervisor !== undefined && !isSupervisorShape(record.supervisor)) {
    return false
  }
  if (record.lastDispatchStatus !== undefined && record.lastDispatchStatus !== null && typeof record.lastDispatchStatus !== 'string') {
    return false
  }
  return true
}

function isTaskShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string' && typeof task.status === 'string' && typeof task.tier === 'string'
}

function isUsageShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const usage = value as Record<string, unknown>
  return Array.isArray(usage.lastActions)
    && typeof usage.tokens === 'number'
    && typeof usage.lastProgressAt === 'number'
    && typeof usage.taskAttempts === 'object' && usage.taskAttempts !== null
    && typeof usage.reviewCycles === 'object' && usage.reviewCycles !== null
    && typeof usage.taskStartedAt === 'object' && usage.taskStartedAt !== null
}

function isActionShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const action = value as Record<string, unknown>
  return typeof action.type === 'string'
}

function isSupervisorShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const hold = value as Record<string, unknown>
  return typeof hold.reason === 'string' && (hold.taskId === null || typeof hold.taskId === 'string')
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT'
}
