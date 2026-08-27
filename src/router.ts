import type { RoutingTable } from './config.js'
import type { ModelTier, Route, TaskContract } from './types.js'

export class RoutingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoutingError'
  }
}

/** Reviewer must be a strictly higher capability tier than the implementer. */
export function reviewTierFor(implementer: ModelTier): ModelTier | 'human' {
  switch (implementer) {
    case 'T0':
      return 'T1'
    case 'T1':
    case 'T2':
      return 'T3'
    case 'T3':
      return 'human'
  }
}

export function assertReviewerAllowed(implementer: ModelTier, reviewer: ModelTier): void {
  const required = reviewTierFor(implementer)
  if (required === 'human') {
    throw new RoutingError('T3 implementation cannot be self-reviewed; escalate to a human')
  }
  if (tierRank(reviewer) < tierRank(required)) {
    throw new RoutingError(`reviewer ${reviewer} is below required ${required} for implementer ${implementer}`)
  }
  if (reviewer === implementer) {
    throw new RoutingError('implementer cannot review their own work')
  }
}

export function routeFor(tier: ModelTier, table: RoutingTable): Route {
  return table[tier]
}

export function nextEscalation(tier: ModelTier): ModelTier | 'human' {
  switch (tier) {
    case 'T0':
      return 'T1'
    case 'T1':
      return 'T2'
    case 'T2':
      return 'T3'
    case 'T3':
      return 'human'
  }
}

export function contractForTask(
  taskId: string,
  title: string,
  tier: ModelTier,
  allowedPaths: readonly string[],
  acceptance: readonly string[],
  maxMinutes: number,
  maxAttempts: number,
): TaskContract {
  return {
    taskId,
    title,
    tier,
    allowedPaths,
    forbidden: ['package.json', '.devloop/GOAL.md', '.devloop/'],
    acceptance,
    budget: { maxMinutes, maxAttempts },
  }
}

function tierRank(tier: ModelTier): number {
  return { T0: 0, T1: 1, T2: 2, T3: 3 }[tier]
}
