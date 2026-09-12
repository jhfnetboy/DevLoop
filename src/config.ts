import s from '@deepseek-ai/schemastery'
import { assertAcceptanceChecks } from './acceptance.js'
import { assertForgeOptions } from './forge.js'
import type { ModelTier, Route } from './types.js'

export interface BudgetLimits {
  readonly maxTaskAttempts: number
  /** Refused dispatches a task may collect before the loop names the problem. */
  readonly maxRefusedDispatches: number
  readonly maxReviewCycles: number
  readonly taskTimeoutMinutes: number
  readonly taskLifetimeMinutes: number
  readonly maxParallelWorkers: number
  readonly maxTokensPerTask: number
  readonly maxCostUsdPerSession: number
  readonly maxCostUsdPerDay: number
  readonly maxSameAction: number
  readonly noProgressMinutes: number
}

export interface RoutingTable {
  readonly T0: Route
  readonly T1: Route
  readonly T2: Route
  readonly T3: Route
}

export interface ForgeConfig {
  /** Canonical push URL. The workspace's own remotes are never trusted for this. */
  readonly pushUrl: string
  readonly base: string
  readonly command: string
  /** GitHub logins allowed to decide a task. Empty means the forge route cannot review. */
  readonly reviewers: string[]
  readonly pollIntervalMs: number
  /** 0 takes the wait bound from the task contract's own time budget. */
  readonly maxWaitMs: number
}

export interface Config {
  readonly root: string
  /**
   * Commands run in a task's worktree before it goes to review, as argv lists.
   * Empty by default: running them runs code a worker wrote, which is a choice
   * an operator makes rather than one this inherits.
   */
  readonly acceptance: string[][]
  readonly acceptanceTimeoutMinutes: number
  /**
   * PR-daemon's pre-PR checker as argv, run on every finished task before review
   * (DevLoop appends --base/--repo/--profile/--json-only). Empty: not run.
   */
  readonly prePrCheck: string[]
  readonly prePrProfile: string
  readonly prePrTimeoutMinutes: number
  readonly enabled: boolean
  readonly tickIntervalMs: number
  readonly agentBackend: 'noop' | 'routed' | 'dsh' | 'claude' | 'codex'
  readonly budget: BudgetLimits
  readonly plannerRoute: Route
  readonly reviewerRoute: Route
  readonly routing: RoutingTable
  /** Only consulted when a route names the `forge` backend. */
  readonly forge: ForgeConfig
  /**
   * The day's spend summed over every project this process runs, beyond which
   * no loop starts new work until UTC midnight. 0 means the same figure as
   * `budget.maxCostUsdPerDay`, so registering more projects never raises what
   * the operator can be charged in a day. Not consulted with a single project.
   */
  readonly maxCostUsdPerDayAllProjects: number
}

const routeSchema = (tier: ModelTier, backend: string, model: string) =>
  s.object({
    tier: s.const(tier).default(tier),
    backend: s.string().default(backend),
    model: s.string().default(model),
  })

export const ConfigSchema: s<Config> = s.object({
  root: s.string().default(process.cwd()),
  acceptance: s.array(s.array(s.string())).default([]),
  acceptanceTimeoutMinutes: s.number().step(1).min(1).max(600).default(15),
  prePrCheck: s.array(s.string()).default([]),
  prePrProfile: s.string().default('devloop'),
  prePrTimeoutMinutes: s.number().step(1).min(1).max(60).default(5),
  enabled: s.boolean().default(true),
  tickIntervalMs: s.number().step(1).min(500).default(2000),
  maxCostUsdPerDayAllProjects: s.number().min(0).default(0),
  agentBackend: s.union([
    s.const('noop'),
    s.const('routed'),
    s.const('dsh'),
    s.const('claude'),
    s.const('codex'),
  ]).default('noop'),
  plannerRoute: routeSchema('T3', 'codex', 'gpt-5.4').default({
    tier: 'T3', backend: 'codex', model: 'gpt-5.4',
  }),
  reviewerRoute: routeSchema('T3', 'claude', 'opus').default({
    tier: 'T3', backend: 'claude', model: 'opus',
  }),
  budget: s.object({
    maxTaskAttempts: s.number().step(1).min(1).default(3),
    maxRefusedDispatches: s.number().step(1).min(1).default(2),
    maxReviewCycles: s.number().step(1).min(1).default(2),
    taskTimeoutMinutes: s.number().step(1).min(1).default(45),
    taskLifetimeMinutes: s.number().step(1).min(1).default(135),
    maxParallelWorkers: s.number().step(1).min(1).default(5),
    maxTokensPerTask: s.number().step(1).min(1).default(500_000),
    maxCostUsdPerSession: finiteCostCap(2),
    maxCostUsdPerDay: finiteCostCap(20),
    maxSameAction: s.number().step(1).min(1).max(20).default(3),
    noProgressMinutes: s.number().step(1).min(1).default(15),
  }).default({
    maxTaskAttempts: 3,
    maxRefusedDispatches: 2,
    maxReviewCycles: 2,
    taskTimeoutMinutes: 45,
    taskLifetimeMinutes: 135,
    maxParallelWorkers: 5,
    maxTokensPerTask: 500_000,
    maxCostUsdPerSession: 2,
    maxCostUsdPerDay: 20,
    maxSameAction: 3,
    noProgressMinutes: 15,
  }),
  forge: s.object({
    pushUrl: s.string().default(''),
    base: s.string().default('main'),
    command: s.string().default('gh'),
    reviewers: s.array(s.string()).default([]),
    pollIntervalMs: s.number().step(1).min(1_000).max(2_147_483_647).default(30_000),
    maxWaitMs: s.number().step(1).min(0).max(2_147_483_647).default(0),
  }).default({ pushUrl: '', base: 'main', command: 'gh', reviewers: [], pollIntervalMs: 30_000, maxWaitMs: 0 }),
  routing: s.object({
    T0: routeSchema('T0', 'local', 'qwen-coder-7b').default({
      tier: 'T0', backend: 'local', model: 'qwen-coder-7b',
    }),
    T1: routeSchema('T1', 'dsh', 'deepseek-v4-flash').default({
      tier: 'T1', backend: 'dsh', model: 'deepseek-v4-flash',
    }),
    T2: routeSchema('T2', 'dsh', 'deepseek-v4-pro').default({
      tier: 'T2', backend: 'dsh', model: 'deepseek-v4-pro',
    }),
    T3: routeSchema('T3', 'codex', 'gpt-5.4').default({
      tier: 'T3', backend: 'codex', model: 'gpt-5.4',
    }),
  }).default({
    T0: { tier: 'T0', backend: 'local', model: 'qwen-coder-7b' },
    T1: { tier: 'T1', backend: 'dsh', model: 'deepseek-v4-flash' },
    T2: { tier: 'T2', backend: 'dsh', model: 'deepseek-v4-pro' },
    T3: { tier: 'T3', backend: 'codex', model: 'gpt-5.4' },
  }),
})

export const Config = ConfigSchema

export function resolveConfig(raw: unknown): Config {
  const config = ConfigSchema((raw ?? {}) as Config)
  assertFiniteCost(config.budget.maxCostUsdPerSession, 'budget.maxCostUsdPerSession')
  assertFiniteCost(config.budget.maxCostUsdPerDay, 'budget.maxCostUsdPerDay')
  assertForgeOptions(config.forge)
  assertAcceptanceChecks(config.acceptance)
  const lifetime = Math.max(
    config.budget.taskLifetimeMinutes,
    config.budget.taskTimeoutMinutes * config.budget.maxTaskAttempts,
  )
  if (lifetime === config.budget.taskLifetimeMinutes) return config
  return {
    ...config,
    budget: { ...config.budget, taskLifetimeMinutes: lifetime },
  }
}

function finiteCostCap(fallback: number) {
  return s.number().min(0).max(Number.MAX_VALUE).default(fallback)
}

function assertFiniteCost(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`)
  }
}
