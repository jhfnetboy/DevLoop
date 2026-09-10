import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_V41_FLASH_EFFECTIVE_FROM,
  isPricedModel,
  peakBand,
  priceUsage,
  toUsd,
  totalTokens,
} from '../src/pricing.ts'

/** A Beijing wall-clock time as an instant. Beijing is a fixed UTC+8. */
const beijing = (
  year: number, month: number, day: number, hour: number, minute = 0,
): number => Date.UTC(year, month - 1, day, hour - 8, minute)

// A Thursday, after the prices took effect.
const THURSDAY = { year: 2026, month: 9, day: 17 } as const
const at = (hour: number, minute = 0): number =>
  beijing(THURSDAY.year, THURSDAY.month, THURSDAY.day, hour, minute)

describe('peakBand', () => {
  it('reads the two published weekday windows, and the gap between them', () => {
    expect(peakBand(at(8, 59))).toBe('offPeak')
    expect(peakBand(at(9))).toBe('peak')
    expect(peakBand(at(11, 59))).toBe('peak')
    // Stated as 9:00~12:00 and 14:00~18:00, so noon belongs to neither.
    expect(peakBand(at(12))).toBe('offPeak')
    expect(peakBand(at(13, 59))).toBe('offPeak')
    expect(peakBand(at(14))).toBe('peak')
    expect(peakBand(at(17, 59))).toBe('peak')
    expect(peakBand(at(18))).toBe('offPeak')
    expect(peakBand(at(3))).toBe('offPeak')
  })

  it('treats every weekend hour as off-peak', () => {
    // 2026-09-19 is a Saturday, 2026-09-20 a Sunday.
    expect(peakBand(beijing(2026, 9, 19, 10))).toBe('offPeak')
    expect(peakBand(beijing(2026, 9, 20, 15))).toBe('offPeak')
    // The Friday before is a working day.
    expect(peakBand(beijing(2026, 9, 18, 10))).toBe('peak')
  })

  it('is decided by Beijing time, not the host timezone', () => {
    // 01:00 UTC is 09:00 Beijing on the same weekday: peak, wherever we run.
    expect(peakBand(Date.UTC(2026, 8, 17, 1, 0))).toBe('peak')
    // 13:00 UTC is 21:00 Beijing: off-peak, though it is business hours in UTC.
    expect(peakBand(Date.UTC(2026, 8, 17, 13, 0))).toBe('offPeak')
  })
})

describe('priceUsage', () => {
  const usage = { cacheHitInput: 1_000_000, cacheMissInput: 1_000_000, output: 1_000_000 }

  it('bills a million of each at the published off-peak prices', () => {
    const result = priceUsage('deepseek-v4.1-flash', usage, at(3))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.price.band).toBe('offPeak')
    expect(result.price.currency).toBe('CNY')
    // 0.02 + 1 + 4
    expect(result.price.amount).toBeCloseTo(5.02, 10)
  })

  it('doubles every band at peak, which is what the notice states', () => {
    const result = priceUsage('deepseek-v4.1-flash', usage, at(10))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.price.band).toBe('peak')
    // 0.04 + 2 + 8
    expect(result.price.amount).toBeCloseTo(10.04, 10)
  })

  it('prices a V4 Pro request as Flash, and says why', () => {
    const pro = priceUsage('deepseek-v4-pro', usage, at(3))
    const flash = priceUsage('deepseek-v4.1-flash', usage, at(3))
    expect(pro.ok && flash.ok).toBe(true)
    if (!pro.ok || !flash.ok) return
    expect(pro.price.amount).toBe(flash.price.amount)
    expect(pro.price.billedAs).toBe('deepseek-v4.1-flash')
    expect(pro.price.note).toMatch(/routed to V4.1 Flash/)
  })

  it('scales below a million tokens rather than rounding to a whole card', () => {
    const result = priceUsage(
      'deepseek-v4.1-flash',
      { cacheHitInput: 0, cacheMissInput: 250_000, output: 10_000 },
      at(3),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 0.25 * 1 + 0.01 * 4
    expect(result.price.amount).toBeCloseTo(0.29, 10)
  })

  it('refuses to price a model with no published rate', () => {
    // The T1 route's model. The notice priced V4.1 Flash and said nothing
    // about this one, so it is unpriced rather than free.
    expect(isPricedModel('deepseek-v4-flash')).toBe(false)
    const result = priceUsage('deepseek-v4-flash', usage, at(3))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unpriced_model')
  })

  it('refuses a dispatch older than the price it would be billed at', () => {
    const result = priceUsage('deepseek-v4.1-flash', usage, DEEPSEEK_V41_FLASH_EFFECTIVE_FROM - 1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('before_effective_date')
  })

  it('starts pricing exactly at 2026-09-10 12:00 Beijing time', () => {
    expect(DEEPSEEK_V41_FLASH_EFFECTIVE_FROM).toBe(beijing(2026, 9, 10, 12))
    const result = priceUsage('deepseek-v4.1-flash', usage, DEEPSEEK_V41_FLASH_EFFECTIVE_FROM)
    expect(result.ok).toBe(true)
  })

  it('refuses token counts it cannot bill', () => {
    for (const bad of [
      { cacheHitInput: -1, cacheMissInput: 0, output: 0 },
      { cacheHitInput: 0, cacheMissInput: Number.NaN, output: 0 },
      { cacheHitInput: 0, cacheMissInput: 0, output: Number.POSITIVE_INFINITY },
    ]) {
      const result = priceUsage('deepseek-v4.1-flash', bad, at(3))
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('unusable_usage')
    }
  })

  it('prices an empty dispatch at nothing', () => {
    const result = priceUsage(
      'deepseek-v4.1-flash',
      { cacheHitInput: 0, cacheMissInput: 0, output: 0 },
      at(3),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.price.amount).toBe(0)
  })
})

describe('toUsd', () => {
  const price = {
    currency: 'CNY' as const,
    amount: 7,
    band: 'offPeak' as const,
    billedAs: 'deepseek-v4.1-flash',
  }

  it('converts only when an operator has supplied a rate', () => {
    expect(toUsd(price, 7)).toBe(1)
  })

  it('returns null rather than a cost cap fed by a guessed rate', () => {
    expect(toUsd(price, 0)).toBeNull()
    expect(toUsd(price, -1)).toBeNull()
    expect(toUsd(price, Number.NaN)).toBeNull()
  })
})

describe('totalTokens', () => {
  it('sums the split, because the per-task token budget has no bands', () => {
    expect(totalTokens({ cacheHitInput: 1, cacheMissInput: 2, output: 4 })).toBe(7)
  })
})
