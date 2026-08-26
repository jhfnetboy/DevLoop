import s from '@deepseek-ai/schemastery'
import type { ModelTier, Route } from './types.js'

export interface BudgetLimits {
  readonly maxTaskAttempts: number
  readonly maxReviewCycles: number
  readonly taskTimeoutMinutes: number
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

export interface Config {
  readonly root: string
  readonly enabled: boolean
  readonly tickIntervalMs: number
  readonly agentBackend: 'noop' | 'dsh'
  readonly budget: BudgetLimits
  readonly routing: RoutingTable
}

const routeSchema = (tier: ModelTier, backend: string, model: string) =>
  s.object({
    tier: s.const(tier).default(tier),
    backend: s.string().default(backend),
    model: s.string().default(model),
  })

export const ConfigSchema: s<Config> = s.object({
  root: s.string().default(process.cwd()),
  enabled: s.boolean().default(true),
  tickIntervalMs: s.number().step(1).min(500).default(2000),
  agentBackend: s.union([s.const('noop'), s.const('dsh')]).default('noop'),
  budget: s.object({
    maxTaskAttempts: s.number().step(1).min(1).default(3),
    maxReviewCycles: s.number().step(1).min(1).default(2),
    taskTimeoutMinutes: s.number().step(1).min(1).default(45),
    maxParallelWorkers: s.number().step(1).min(1).default(5),
    maxTokensPerTask: s.number().step(1).min(1).default(500_000),
    maxCostUsdPerSession: finiteCostCap(2),
    maxCostUsdPerDay: finiteCostCap(20),
    maxSameAction: s.number().step(1).min(1).max(20).default(3),
    noProgressMinutes: s.number().step(1).min(1).default(15),
  }).default({
    maxTaskAttempts: 3,
    maxReviewCycles: 2,
    taskTimeoutMinutes: 45,
    maxParallelWorkers: 5,
    maxTokensPerTask: 500_000,
    maxCostUsdPerSession: 2,
    maxCostUsdPerDay: 20,
    maxSameAction: 3,
    noProgressMinutes: 15,
  }),
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
  return config
}

function finiteCostCap(fallback: number) {
  return s.number().min(0).max(Number.MAX_VALUE).default(fallback)
}

function assertFiniteCost(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`)
  }
}
