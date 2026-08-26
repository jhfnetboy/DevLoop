import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import {
  assertReviewerAllowed,
  nextEscalation,
  reviewTierFor,
  routeFor,
  RoutingError,
} from '../src/router.ts'

const table = resolveConfig({}).routing

describe('router', () => {
  it('maps implementer to a higher review tier', () => {
    expect(reviewTierFor('T0')).toBe('T1')
    expect(reviewTierFor('T1')).toBe('T3')
    expect(reviewTierFor('T2')).toBe('T3')
    expect(reviewTierFor('T3')).toBe('human')
  })

  it('rejects self-review', () => {
    expect(() => assertReviewerAllowed('T1', 'T1')).toThrow(RoutingError)
  })

  it('rejects a reviewer below the required tier', () => {
    expect(() => assertReviewerAllowed('T2', 'T1')).toThrow(RoutingError)
  })

  it('accepts T3 reviewing T1', () => {
    expect(() => assertReviewerAllowed('T1', 'T3')).not.toThrow()
  })

  it('escalates T0 → T1 → T2 → T3 → human', () => {
    expect(nextEscalation('T0')).toBe('T1')
    expect(nextEscalation('T1')).toBe('T2')
    expect(nextEscalation('T2')).toBe('T3')
    expect(nextEscalation('T3')).toBe('human')
  })

  it('reads the configured realization for a tier', () => {
    expect(routeFor('T1', table)).toEqual({
      tier: 'T1',
      backend: 'dsh',
      model: 'deepseek-v4-flash',
    })
  })
})
