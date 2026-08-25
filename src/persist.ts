import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { emptyUsage } from './budget.js'
import type { LoopState } from './types.js'
import { STATE_VERSION } from './types.js'

export const DEVLOOP_DIR = '.devloop'
export const STATE_FILE = 'STATE.json'
export const GOAL_FILE = 'GOAL.md'
export const LOCK_DIR = 'LOCK'
export const LOCK_STALE_MS = 30_000

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

export function lockPath(root: string): string {
  return join(devloopDir(root), LOCK_DIR)
}

/**
 * Cross-process mutex for one read-modify-write tick.
 * Returns `locked` when another live holder already owns the directory.
 */
export async function withStateLock<T>(root: string, fn: () => Promise<T>): Promise<T | 'locked'> {
  const dir = lockPath(root)
  if (!await tryLock(dir)) return 'locked'
  try {
    return await fn()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function tryLock(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: false })
    return true
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  try {
    const info = await stat(dir)
    if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return false
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: false })
    return true
  } catch {
    return false
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
  return isFiniteNumber(usage.tokens)
    && isFiniteNumber(usage.costUsdSession)
    && isFiniteNumber(usage.costUsdDay)
    && isFiniteNumber(usage.parallelWorkers)
    && isFiniteNumber(usage.lastProgressAt)
    && Array.isArray(usage.lastActions)
    && usage.lastActions.every(item => typeof item === 'string')
    && isNumberRecord(usage.taskAttempts)
    && isNumberRecord(usage.reviewCycles)
    && isNumberRecord(usage.taskStartedAt)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNumberRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(isFiniteNumber)
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
  return isErrno(error, 'ENOENT')
}

function isAlreadyExists(error: unknown): boolean {
  return isErrno(error, 'EEXIST')
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === code
}
