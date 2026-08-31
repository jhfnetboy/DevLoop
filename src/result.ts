import type { ModelTier, ReviewVerdict, Risk } from './types.js'

export const RESULT_VERSION = 1 as const

export interface PlannedTask {
  readonly id: string
  readonly title: string
  readonly tier: ModelTier
  readonly risk: Risk
  readonly allowedPaths: readonly string[]
  readonly acceptance: readonly string[]
}

export interface PlanResult {
  readonly version: typeof RESULT_VERSION
  readonly kind: 'plan'
  readonly tasks: readonly PlannedTask[]
}

export interface ImplementationResult {
  readonly version: typeof RESULT_VERSION
  readonly kind: 'implementation'
  readonly taskId: string
  readonly outcome: 'completed' | 'blocked' | 'failed'
  readonly summary: string
}

export interface ReviewResult {
  readonly version: typeof RESULT_VERSION
  readonly kind: 'review'
  readonly taskId: string
  readonly reviewedSha: string
  readonly verdict: ReviewVerdict
  readonly notes?: string
}

export type DevloopResult = PlanResult | ImplementationResult | ReviewResult

const RESULT_START = '<devloop_result>'
const RESULT_END = '</devloop_result>'
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SHA = /^[0-9a-f]{40}$/i
const TIERS = new Set<ModelTier>(['T0', 'T1', 'T2', 'T3'])
const RISKS = new Set<Risk>(['low', 'medium', 'high'])
const VERDICTS = new Set<ReviewVerdict>(['PASS', 'PASS_WITH_NOTES', 'REWORK', 'REPLAN', 'BLOCKED'])
const MAX_TASKS = 50
const MAX_TEXT = 8_192

/** Parse the single machine envelope emitted by a CLI or provider. */
export function parseDevloopResult(output: string): DevloopResult {
  const start = output.indexOf(RESULT_START)
  const nextStart = output.indexOf(RESULT_START, start + RESULT_START.length)
  if (nextStart >= 0) throw new Error('multiple devloop_result envelopes')
  const end = output.indexOf(RESULT_END, start + RESULT_START.length)
  if (start < 0 || end < 0) throw new Error('missing devloop_result envelope')
  const raw = output.slice(start + RESULT_START.length, end).trim()
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('invalid devloop_result JSON')
  }
  return validateDevloopResult(value)
}

/** Validate provider-native structured output at the trust boundary. */
export function validateDevloopResult(value: unknown): DevloopResult {
  if (!isRecord(value) || value.version !== RESULT_VERSION || typeof value.kind !== 'string') {
    throw new Error('invalid devloop_result header')
  }
  if (value.kind === 'plan') return validatePlan(value)
  if (value.kind === 'implementation') return validateImplementation(value)
  if (value.kind === 'review') return validateReview(value)
  throw new Error('unknown devloop_result kind')
}

export function resultInstructions(kind: DevloopResult['kind'], taskId?: string, reviewedSha?: string): string {
  if (kind === 'plan') {
    return 'Finish with exactly one <devloop_result>{"version":1,"kind":"plan","tasks":[{"id":"TASK-001","title":"...","tier":"T1","risk":"low","allowedPaths":["src/**"],"acceptance":["..."]}]}</devloop_result> envelope.'
  }
  if (kind === 'implementation') {
    return `Finish with exactly one <devloop_result>{"version":1,"kind":"implementation","taskId":${JSON.stringify(taskId ?? '')},"outcome":"completed","summary":"..."}</devloop_result> envelope. Use outcome blocked or failed when appropriate.`
  }
  return `Review exactly commit ${reviewedSha ?? 'UNKNOWN'}. Finish with exactly one <devloop_result>{"version":1,"kind":"review","taskId":${JSON.stringify(taskId ?? '')},"reviewedSha":${JSON.stringify(reviewedSha ?? '')},"verdict":"PASS","notes":"..."}</devloop_result> envelope. Verdict is PASS, PASS_WITH_NOTES, REWORK, REPLAN, or BLOCKED.`
}

export function protocolRepairInstruction(): string {
  return 'Your previous response had an invalid devloop_result. Do not make additional edits. Inspect the current state and return exactly one valid envelope with strict JSON.'
}

function validatePlan(value: Record<string, unknown>): PlanResult {
  if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > MAX_TASKS) {
    throw new Error(`plan tasks must contain 1-${MAX_TASKS} entries`)
  }
  const tasks = value.tasks.map((entry, index) => validatePlannedTask(entry, index))
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('plan task ids must be unique')
  return { version: RESULT_VERSION, kind: 'plan', tasks }
}

function validatePlannedTask(value: unknown, index: number): PlannedTask {
  if (!isRecord(value)) throw new Error(`plan task ${index} must be an object`)
  const id = shortText(value.id, `plan task ${index} id`)
  if (!TASK_ID.test(id) || id.includes('..') || id.endsWith('.') || id.endsWith('.lock')) {
    throw new Error(`plan task ${index} has unsafe id`)
  }
  const title = shortText(value.title, `plan task ${id} title`)
  if (!TIERS.has(value.tier as ModelTier)) throw new Error(`plan task ${id} has invalid tier`)
  if (!RISKS.has(value.risk as Risk)) throw new Error(`plan task ${id} has invalid risk`)
  const allowedPaths = stringList(value.allowedPaths, `plan task ${id} allowedPaths`, 1, 64)
  const acceptance = stringList(value.acceptance, `plan task ${id} acceptance`, 1, 32)
  return {
    id,
    title,
    tier: value.tier as ModelTier,
    risk: value.risk as Risk,
    allowedPaths,
    acceptance,
  }
}

function validateImplementation(value: Record<string, unknown>): ImplementationResult {
  const taskId = shortText(value.taskId, 'implementation taskId')
  if (!TASK_ID.test(taskId)) throw new Error('implementation taskId is unsafe')
  if (value.outcome !== 'completed' && value.outcome !== 'blocked' && value.outcome !== 'failed') {
    throw new Error('implementation outcome is invalid')
  }
  return {
    version: RESULT_VERSION,
    kind: 'implementation',
    taskId,
    outcome: value.outcome,
    summary: shortText(value.summary, 'implementation summary'),
  }
}

function validateReview(value: Record<string, unknown>): ReviewResult {
  const taskId = shortText(value.taskId, 'review taskId')
  const reviewedSha = shortText(value.reviewedSha, 'review reviewedSha').toLowerCase()
  if (!TASK_ID.test(taskId)) throw new Error('review taskId is unsafe')
  if (!SHA.test(reviewedSha)) throw new Error('review reviewedSha is not a full git SHA')
  if (!VERDICTS.has(value.verdict as ReviewVerdict)) throw new Error('review verdict is invalid')
  const notes = value.notes === undefined ? undefined : shortText(value.notes, 'review notes')
  return {
    version: RESULT_VERSION,
    kind: 'review',
    taskId,
    reviewedSha,
    verdict: value.verdict as ReviewVerdict,
    ...(notes === undefined ? {} : { notes }),
  }
}

function stringList(value: unknown, label: string, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain ${min}-${max} entries`)
  }
  return value.map((entry, index) => shortText(entry, `${label}[${index}]`))
}

function shortText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT || trimmed.includes('\0')) {
    throw new Error(`${label} is empty or too large`)
  }
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
