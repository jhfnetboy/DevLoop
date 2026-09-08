import type { BudgetLimits } from './config.js'
import type { AgentAction } from './backend.js'
import type { LoopState, ModelTier, ReviewVerdict, Risk, Task } from './types.js'
import { worktreeTaskToken } from './worktree.js'

/** A task the planner proposed. Only `id` and `title` are required. */
export interface PlannedTask {
  readonly id: string
  readonly title: string
  readonly tier?: ModelTier
  readonly risk?: Risk
  readonly allowedPaths?: readonly string[]
  readonly acceptance?: readonly string[]
}

/**
 * What a worker actually produced. This is the missing return path: without it
 * a task never leaves `ready`, the latch sees an unchanged dispatch status, and
 * the loop wedges into idle until no-progress halts it.
 */
export type AgentOutcome =
  | { readonly kind: 'plan'; readonly tasks: readonly PlannedTask[] }
  | { readonly kind: 'implement'; readonly ok: boolean; readonly detail?: string }
  | { readonly kind: 'review'; readonly verdict: ReviewVerdict; readonly notes?: string }

/** A planner cannot grow STATE without bound. */
export const MAX_PLANNED_TASKS = 50

const REVIEW_VERDICTS = new Set<ReviewVerdict>([
  'PASS',
  'PASS_WITH_NOTES',
  'REWORK',
  'REPLAN',
  'BLOCKED',
])
const MODEL_TIERS = new Set<ModelTier>(['T0', 'T1', 'T2', 'T3'])
const RISKS = new Set<Risk>(['low', 'medium', 'high'])

/**
 * Pure state transition for a finished worker run. Never calls an LLM, never
 * touches disk. Returns the input state unchanged when the outcome does not
 * match the dispatched action, names an unknown task, or adds nothing — an
 * unchanged state keeps no-progress detection honest.
 */
export function applyOutcome(
  state: LoopState,
  action: AgentAction,
  outcome: AgentOutcome,
  limits: BudgetLimits,
): LoopState {
  if (action.type === 'plan' && outcome.kind === 'plan') {
    return applyPlan(state, outcome.tasks)
  }
  if (action.type === 'delegate' && outcome.kind === 'implement') {
    return applyImplement(state, action.taskId, outcome.ok, limits)
  }
  if (action.type === 'review' && outcome.kind === 'review') {
    return applyReview(state, action.taskId, outcome.verdict, limits)
  }
  return state
}

function applyPlan(state: LoopState, planned: readonly PlannedTask[]): LoopState {
  const known = new Set(state.tasks.map(task => task.id))
  const room = MAX_PLANNED_TASKS - state.tasks.length
  if (room <= 0) return state

  const added: Task[] = []
  for (const item of planned) {
    if (added.length >= room) break
    // Task ids become git branch and directory names; reject anything unsafe here
    // rather than at `git worktree add` time.
    if (worktreeTaskToken(item.id) === null) continue
    if (known.has(item.id)) continue
    known.add(item.id)
    added.push({
      id: item.id,
      title: item.title,
      tier: MODEL_TIERS.has(item.tier as ModelTier) ? item.tier as ModelTier : 'T1',
      status: 'ready',
      risk: RISKS.has(item.risk as Risk) ? item.risk as Risk : 'low',
      attempts: 0,
      reviewCycles: 0,
      allowedPaths: item.allowedPaths ?? [],
      acceptance: item.acceptance ?? [],
    })
  }
  if (added.length === 0) return state
  return { ...state, tasks: [...state.tasks, ...added] }
}

function applyImplement(
  state: LoopState,
  taskId: string,
  ok: boolean,
  limits: BudgetLimits,
): LoopState {
  return mapTask(state, taskId, task => {
    const attempts = task.attempts + 1
    if (ok) {
      // Drop any earlier verdict: fresh code must earn a fresh PASS.
      return { ...withoutVerdict(task), status: 'review_pending', attempts }
    }
    return {
      ...withoutVerdict(task),
      status: attempts >= limits.maxTaskAttempts ? 'failed' : 'rework',
      attempts,
    }
  })
}

function applyReview(
  state: LoopState,
  taskId: string,
  verdict: ReviewVerdict,
  limits: BudgetLimits,
): LoopState {
  if (!REVIEW_VERDICTS.has(verdict)) return state
  const next = mapTask(state, taskId, task => {
    const reviewCycles = task.reviewCycles + 1
    if (verdict === 'PASS' || verdict === 'PASS_WITH_NOTES') {
      return { ...task, status: 'merge_ready', reviewCycles, lastReviewVerdict: verdict }
    }
    if (verdict === 'REWORK') {
      return {
        ...task,
        status: reviewCycles >= limits.maxReviewCycles ? 'blocked' : 'rework',
        reviewCycles,
        lastReviewVerdict: verdict,
      }
    }
    return { ...task, status: 'blocked', reviewCycles, lastReviewVerdict: verdict }
  })
  if (next === state || verdict !== 'REPLAN') return next
  return { ...next, supervisor: state.supervisor ?? { taskId, reason: 'replan_requested' } }
}

function mapTask(state: LoopState, taskId: string, fn: (task: Task) => Task): LoopState {
  if (!state.tasks.some(task => task.id === taskId)) return state
  return { ...state, tasks: state.tasks.map(task => task.id === taskId ? fn(task) : task) }
}

function withoutVerdict(task: Task): Task {
  const { lastReviewVerdict: _dropped, ...rest } = task
  return rest
}

/**
 * Pull the outcome envelope out of a CLI's stdout. Workers print prose around
 * their JSON, so try fenced blocks first (last one wins), then the widest
 * brace span, then the raw text. Returns undefined when nothing parses into
 * the shape the dispatched action expects.
 */
export function readOutcome(text: string, expected: AgentAction['type']): AgentOutcome | undefined {
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const outcome = coerceOutcome(parsed, expected)
    if (outcome) return outcome
  }
  return undefined
}

function jsonCandidates(text: string): string[] {
  const out: string[] = []
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  for (const match of fenced.reverse()) {
    const body = match[1]?.trim()
    if (body) out.push(body)
  }
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open !== -1 && close > open) out.push(text.slice(open, close + 1))
  const trimmed = text.trim()
  if (trimmed) out.push(trimmed)
  return out
}

function coerceOutcome(value: unknown, expected: AgentAction['type']): AgentOutcome | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  // `kind` is optional: a worker answering one dispatched action cannot be
  // reporting on a different one.
  const kind = typeof record.kind === 'string' ? record.kind : expectedKind(expected)
  if (kind !== expectedKind(expected)) return undefined

  if (kind === 'plan') {
    if (!Array.isArray(record.tasks)) return undefined
    const tasks = record.tasks.filter(isPlannedTask)
    return { kind: 'plan', tasks }
  }
  if (kind === 'implement') {
    if (typeof record.ok !== 'boolean') return undefined
    const detail = typeof record.detail === 'string' ? record.detail : undefined
    return { kind: 'implement', ok: record.ok, ...(detail === undefined ? {} : { detail }) }
  }
  if (!REVIEW_VERDICTS.has(record.verdict as ReviewVerdict)) return undefined
  const notes = typeof record.notes === 'string' ? record.notes : undefined
  return { kind: 'review', verdict: record.verdict as ReviewVerdict, ...(notes === undefined ? {} : { notes }) }
}

function expectedKind(action: AgentAction['type']): AgentOutcome['kind'] {
  if (action === 'plan') return 'plan'
  if (action === 'delegate') return 'implement'
  return 'review'
}

function isPlannedTask(value: unknown): value is PlannedTask {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.title === 'string'
}
