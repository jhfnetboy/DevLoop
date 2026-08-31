import { constants, link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { emptyUsage } from './budget.js'
import type { LoopState, ModelTier, ReviewVerdict, Risk, TaskStatus } from './types.js'
import { STATE_VERSION } from './types.js'

export const DEVLOOP_DIR = '.devloop'
export const STATE_FILE = 'STATE.json'
export const GOAL_FILE = 'GOAL.md'
export const LOCK_FILE = 'LOCK'
export const EVENTS_FILE = 'EVENTS.jsonl'
const EVENT_VERSION = 1 as const
const JOURNAL_TAIL_BYTES = 8 * 1024 * 1024

interface StateEvent {
  readonly version: typeof EVENT_VERSION
  readonly revision: number
  readonly at: string
  readonly action: string
  readonly state: LoopState
}

export function devloopDir(root: string): string {
  return join(root, DEVLOOP_DIR)
}

export function statePath(root: string): string {
  return join(devloopDir(root), STATE_FILE)
}

export function goalPath(root: string): string {
  return join(devloopDir(root), GOAL_FILE)
}

export function eventsPath(root: string): string {
  return join(devloopDir(root), EVENTS_FILE)
}

export async function workspaceArmed(root: string): Promise<boolean> {
  try {
    if (!await isLocalDevloopDir(root)) return false
    const goal = await lstat(goalPath(root))
    return goal.isFile() && !goal.isSymbolicLink()
  } catch {
    return false
  }
}

export function emptyState(now: number): LoopState {
  return {
    version: STATE_VERSION,
    revision: 0,
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
  if (!await isLocalDevloopDir(root, { allowMissing: true })) {
    return haltState(now, 'escaped_devloop')
  }
  try {
    const raw = await readFile(statePath(root), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isLoopState(parsed)) {
      return await recoverState(root) ?? haltState(now, 'invalid_state')
    }
    return normalizeLoadedState(parsed)
  } catch (error) {
    if (isNotFound(error)) return await recoverState(root) ?? emptyState(now)
    if (error instanceof SyntaxError) return await recoverState(root) ?? haltState(now, 'invalid_state')
    return haltState(now, 'unreadable_state', { permanent: false })
  }
}

export function lockPath(root: string): string {
  return join(devloopDir(root), LOCK_FILE)
}

function lockNameToken(raw: string): string {
  const trimmed = raw.trim()
  return /^[0-9]{1,16}$/.test(trimmed) ? trimmed : 'corrupt'
}

async function isLocalDevloopDir(root: string, options: { allowMissing?: boolean } = {}): Promise<boolean> {
  const dir = devloopDir(root)
  let meta
  try {
    meta = await lstat(dir)
  } catch (error) {
    return options.allowMissing === true && isNotFound(error)
  }
  if (meta.isSymbolicLink() || !meta.isDirectory()) return false
  const resolvedRoot = await realpath(root)
  const resolvedDir = await realpath(dir)
  return resolvedDir === join(resolvedRoot, DEVLOOP_DIR)
}

export async function assertLocalDevloopDir(root: string): Promise<void> {
  if (!await isLocalDevloopDir(root, { allowMissing: true })) {
    throw new Error('devloop directory must be a real directory inside the workspace')
  }
}

export const LOCK_STALE_MS = 30_000
export const LOCK_HEARTBEAT_MS = 5_000

export type LockResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false }

/**
 * Cross-process mutex for one read-modify-write tick.
 * `ok: false` means another live, fresh holder owns the file.
 *
 * The critical section may outlast `LOCK_STALE_MS` (git worktree prepare
 * sits inside it). Heartbeats refresh LOCK mtime so a live holder is not
 * stolen. Steal still requires stale mtime; a dead holder without
 * heartbeats remains takeable after `LOCK_STALE_MS`.
 */
export async function withStateLock<T>(root: string, fn: () => Promise<T>): Promise<LockResult<T>> {
  await assertLocalDevloopDir(root)
  const file = lockPath(root)
  if (!await tryLock(file)) return { ok: false }
  const beat = setInterval(() => {
    void touchLock(file)
  }, LOCK_HEARTBEAT_MS)
  beat.unref()
  try {
    return { ok: true, value: await fn() }
  } finally {
    clearInterval(beat)
    await releaseLock(file)
  }
}

async function tryLock(file: string): Promise<boolean> {
  if (await exclusiveCreate(file)) return true
  const observed = await readLockBody(file)
  if (observed === null) return false
  const holder = parseHolderPid(observed)
  const stale = await isLockStale(file)
  if (holder === 'pending') {
    if (!stale) return false
  } else if (holder !== null && isPidAlive(holder) && !stale) {
    return false
  }
  const taking = `${file}.taking.${lockNameToken(observed)}`
  if (!await claimFile(taking)) return false
  try {
    const current = await readLockBody(file)
    if (current !== observed) return false
    const stolen = `${file}.${process.pid}.${Date.now()}.stale`
    try {
      await rename(file, stolen)
    } catch {
      return false
    }
    const moved = await readLockBody(stolen)
    if (moved !== observed) {
      await rm(stolen, { force: true })
      return false
    }
    const created = await exclusiveCreate(file)
    await rm(stolen, { force: true })
    return created
  } finally {
    await rm(taking, { force: true })
  }
}

async function claimFile(file: string): Promise<boolean> {
  if (await exclusiveWrite(file)) return true
  const observed = await readLockBody(file)
  if (observed === null) return exclusiveWrite(file)
  const holder = parseHolderPid(observed)
  if (holder !== null && holder !== 'pending' && isPidAlive(holder)) return false
  const stolen = `${file}.${process.pid}.${Date.now()}.stale`
  try {
    await rename(file, stolen)
  } catch {
    return false
  }
  await rm(stolen, { force: true })
  return exclusiveWrite(file)
}

async function exclusiveWrite(file: string): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${Date.now()}.body`
  await writeFile(tmp, String(process.pid), 'utf8')
  try {
    await link(tmp, file)
    return true
  } catch (error) {
    if (isAlreadyExists(error)) return false
    throw error
  } finally {
    await rm(tmp, { force: true })
  }
}

async function readLockBody(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

function parseHolderPid(raw: string): number | 'pending' | null {
  if (raw.trim() === '') return 'pending'
  if (!/^[0-9]+$/.test(raw.trim())) return null
  const pid = Number(raw.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

async function isLockStale(file: string): Promise<boolean> {
  try {
    const meta = await lstat(file)
    return Date.now() - meta.mtimeMs >= LOCK_STALE_MS
  } catch {
    return false
  }
}

async function touchLock(file: string): Promise<void> {
  try {
    const body = await readFile(file, 'utf8')
    if (body.trim() !== String(process.pid)) return
    const now = new Date()
    await utimes(file, now, now)
  } catch {
    return
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isErrno(error, 'EPERM')
  }
}

async function exclusiveCreate(file: string): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${Date.now()}.claim`
  await writeFile(tmp, String(process.pid), 'utf8')
  try {
    await link(tmp, file)
    return true
  } catch (error) {
    if (isAlreadyExists(error)) return false
    throw error
  } finally {
    await rm(tmp, { force: true })
  }
}

async function releaseLock(file: string): Promise<void> {
  let body: string
  try {
    body = await readFile(file, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  if (body.trim() !== String(process.pid)) return
  try {
    await unlink(file)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
}

export async function saveState(
  root: string,
  state: LoopState,
  options: { readonly expectedRevision?: number; readonly action?: string } = {},
): Promise<LoopState> {
  await assertLocalDevloopDir(root)
  const file = statePath(root)
  await mkdir(dirname(file), { recursive: true })
  const currentRevision = await persistedRevision(root)
  if (options.expectedRevision !== undefined && currentRevision !== options.expectedRevision) {
    throw new Error(`state_revision_conflict: expected ${options.expectedRevision}, found ${currentRevision}`)
  }
  const persisted: LoopState = { ...state, revision: currentRevision + 1 }
  await appendStateEvent(root, persisted, options.action ?? actionLabel(persisted))
  const temp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`
  await writeFile(temp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
  await rename(temp, file)
  return persisted
}

async function persistedRevision(root: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(root), 'utf8'))
    if (isLoopState(parsed)) return normalizeLoadedState(parsed).revision
  } catch {
    // Fall through to the durable journal.
  }
  return (await recoverState(root))?.revision ?? 0
}

async function appendStateEvent(root: string, state: LoopState, action: string): Promise<void> {
  const file = eventsPath(root)
  const event: StateEvent = {
    version: EVENT_VERSION,
    revision: state.revision,
    at: new Date().toISOString(),
    action,
    state,
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW
  const handle = await open(file, flags, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function recoverState(root: string): Promise<LoopState | null> {
  let handle
  try {
    handle = await open(eventsPath(root), constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0) return null
    const length = Math.min(stat.size, JOURNAL_TAIL_BYTES)
    const offset = stat.size - length
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, offset)
    let text = buffer.toString('utf8')
    if (offset > 0) text = text.slice(text.indexOf('\n') + 1)
    const rawLines = text.split('\n')
    const endedWithNewline = text.endsWith('\n')
    const lines = rawLines.filter(Boolean)
    let latest: LoopState | null = null
    let priorRevision: number | null = null
    for (let index = 0; index < lines.length; index += 1) {
      try {
        const parsed: unknown = JSON.parse(lines[index]!)
        if (!isStateEvent(parsed)) return null
        if (priorRevision !== null && parsed.revision !== priorRevision + 1) return null
        priorRevision = parsed.revision
        latest = normalizeLoadedState(parsed.state)
      } catch {
        // Only a non-newline-terminated final append may be torn.
        if (index !== lines.length - 1 || endedWithNewline) return null
      }
    }
    return latest
  } catch (error) {
    if (isNotFound(error)) return null
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isStateEvent(value: unknown): value is StateEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<StateEvent>
  return event.version === EVENT_VERSION
    && isNonNegInt(event.revision)
    && typeof event.at === 'string'
    && typeof event.action === 'string'
    && isLoopState(event.state)
    && normalizeLoadedState(event.state).revision === event.revision
}

function actionLabel(state: LoopState): string {
  const action = state.lastAction
  if (action.type === 'delegate' || action.type === 'review' || action.type === 'merge') {
    return `${action.type}:${action.taskId}`
  }
  if (action.type === 'stop') return `stop:${action.reason}`
  if (action.type === 'escalate') return `escalate:${action.taskId ?? '_'}:${action.reason}`
  return action.type
}

function haltState(now: number, reason: string, options: { permanent?: boolean } = {}): LoopState {
  const permanent = options.permanent !== false
  return {
    ...emptyState(now),
    killSwitch: permanent,
    supervisor: { taskId: null, reason },
    lastAction: permanent ? { type: 'stop', reason: 'kill_switch' } : { type: 'idle' },
    updatedAt: new Date(now).toISOString(),
  }
}

function isLoopState(value: unknown): value is LoopState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<LoopState>
  if (record.version !== STATE_VERSION) return false
  if (record.revision !== undefined && !isNonNegInt(record.revision)) return false
  if (typeof record.goalCompleted !== 'boolean') return false
  if (typeof record.killSwitch !== 'boolean') return false
  if (!Array.isArray(record.tasks)) return false
  if (!record.tasks.every(isTaskShape)) return false
  const ids = record.tasks.map(task => (task as { id: string }).id)
  if (new Set(ids).size !== ids.length) return false
  if (!isUsageShape(record.usage)) return false
  if (!isActionShape(record.lastAction)) return false
  if (record.tasks.some(task => {
    const entry = task as { id: string; status: string }
    return entry.status === 'running' && !Object.hasOwn((record.usage as { taskStartedAt: object }).taskStartedAt, entry.id)
  })) {
    return false
  }
  if (record.supervisor !== null && !isSupervisorShape(record.supervisor)) {
    return false
  }
  if (typeof record.updatedAt !== 'string' || record.updatedAt.length === 0) return false
  if (record.lastDispatchStatus !== undefined && record.lastDispatchStatus !== null && typeof record.lastDispatchStatus !== 'string') {
    return false
  }
  return true
}

function normalizeLoadedState(state: LoopState): LoopState {
  return { ...state, revision: state.revision ?? 0 }
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
const REVIEW_VERDICTS = new Set<ReviewVerdict>([
  'PASS',
  'PASS_WITH_NOTES',
  'REWORK',
  'REPLAN',
  'BLOCKED',
])

function isTaskShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string'
    && isSafeKey(task.id)
    && typeof task.title === 'string'
    && MODEL_TIERS.has(task.tier as ModelTier)
    && TASK_STATUSES.has(task.status as TaskStatus)
    && RISKS.has(task.risk as Risk)
    && isNonNegInt(task.attempts)
    && isNonNegInt(task.reviewCycles)
    && isStringArray(task.allowedPaths)
    && isStringArray(task.acceptance)
    && (task.lastReviewVerdict === undefined || REVIEW_VERDICTS.has(task.lastReviewVerdict as ReviewVerdict))
    && (task.baseSha === undefined || (typeof task.baseSha === 'string' && /^[0-9a-f]{40}$/i.test(task.baseSha)))
    && (task.implementationSha === undefined || (typeof task.implementationSha === 'string' && /^[0-9a-f]{40}$/i.test(task.implementationSha)))
    && (task.implementer === undefined || (typeof task.implementer === 'string' && task.implementer.length > 0))
    && (task.reviewer === undefined || (typeof task.reviewer === 'string' && task.reviewer.length > 0))
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
  return Object.keys(value).every(isSafeKey) && Object.values(value).every(isNonNegInt)
}

function isNonNegNumberRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.keys(value).every(isSafeKey) && Object.values(value).every(isNonNegNumber)
}

function isSafeKey(id: string): boolean {
  return id.length > 0
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isActionShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const action = value as Record<string, unknown>
  switch (action.type) {
    case 'idle':
    case 'plan':
      return true
    case 'stop':
      return action.reason === 'goal_complete'
        || action.reason === 'budget'
        || action.reason === 'blocked'
        || action.reason === 'kill_switch'
    case 'delegate':
    case 'review':
    case 'merge':
      return typeof action.taskId === 'string' && action.taskId.length > 0
    case 'escalate':
      return typeof action.reason === 'string'
        && action.reason.length > 0
        && (action.taskId === null || typeof action.taskId === 'string')
    default:
      return false
  }
}

function isSupervisorShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const hold = value as Record<string, unknown>
  return typeof hold.reason === 'string' && hold.reason.length > 0 && (hold.taskId === null || typeof hold.taskId === 'string')
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
