import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { emptyUsage } from './budget.js'
import type { LoopState, ModelTier, Risk, TaskStatus } from './types.js'
import { STATE_VERSION } from './types.js'

export const DEVLOOP_DIR = '.devloop'
export const STATE_FILE = 'STATE.json'
export const GOAL_FILE = 'GOAL.md'
export const LOCK_FILE = 'LOCK'
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
  return join(devloopDir(root), LOCK_FILE)
}

/**
 * Cross-process mutex for one read-modify-write tick.
 * Returns `locked` when another live holder already owns the file.
 */
export async function withStateLock<T>(root: string, fn: () => Promise<T>): Promise<T | 'locked'> {
  const file = lockPath(root)
  if (!await tryLock(file)) return 'locked'
  try {
    return await fn()
  } finally {
    await releaseLock(file)
  }
}

async function tryLock(file: string): Promise<boolean> {
  if (await exclusiveCreate(file)) return true
  try {
    const info = await stat(file)
    if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return false
  } catch {
    return exclusiveCreate(file)
  }
  const stolen = `${file}.${process.pid}.${Date.now()}.stale`
  try {
    await rename(file, stolen)
  } catch {
    return false
  }
  await rm(stolen, { force: true })
  return exclusiveCreate(file)
}

async function exclusiveCreate(file: string): Promise<boolean> {
  try {
    const handle = await open(file, 'wx')
    try {
      await handle.writeFile(String(process.pid), 'utf8')
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (isAlreadyExists(error)) return false
    throw error
  }
}

async function releaseLock(file: string): Promise<void> {
  try {
    const body = await readFile(file, 'utf8')
    if (body.trim() === String(process.pid)) {
      await rm(file, { force: true })
    }
  } catch {
    // already released or stolen
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

const TASK_STATUSES = new Set<TaskStatus>([
  'ready',
  'running',
  'review_pending',
  'merge_ready',
  'rework',
  'blocked',
  'done',
  'failed',
])
const MODEL_TIERS = new Set<ModelTier>(['T0', 'T1', 'T2', 'T3'])
const RISKS = new Set<Risk>(['low', 'medium', 'high'])

function isTaskShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string'
    && typeof task.title === 'string'
    && MODEL_TIERS.has(task.tier as ModelTier)
    && TASK_STATUSES.has(task.status as TaskStatus)
    && RISKS.has(task.risk as Risk)
    && isNonNegInt(task.attempts)
    && isNonNegInt(task.reviewCycles)
    && isStringArray(task.allowedPaths)
    && isStringArray(task.acceptance)
}

function isUsageShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const usage = value as Record<string, unknown>
  return isNonNegNumberRecord(usage.tokens)
    && isNonNegNumber(usage.costUsdSession)
    && isNonNegNumber(usage.costUsdDay)
    && isNonNegInt(usage.parallelWorkers)
    && isNonNegInt(usage.lastProgressAt)
    && isStringArray(usage.lastActions)
    && isNonNegIntRecord(usage.taskAttempts)
    && isNonNegIntRecord(usage.reviewCycles)
    && isNonNegIntRecord(usage.taskStartedAt)
}

function isNonNegNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonNegInt(value: unknown): value is number {
  return isNonNegNumber(value) && Number.isInteger(value)
}

function isNonNegIntRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(isNonNegInt)
}

function isNonNegNumberRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(isNonNegNumber)
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
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
