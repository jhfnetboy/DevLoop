/**
 * What a dispatch cost, from token counts a provider reported.
 *
 * The loop's cost caps are fed by `BackendResult.costUsd`, which only a backend
 * that reports money can fill. A provider that reports tokens and nothing else
 * leaves the caps blind — and DeepSeek's `headless` CLI is exactly that. This
 * turns published prices plus token counts into a cost, so the tier that spends
 * the most stops being the tier the budget cannot see.
 *
 * Two rules hold throughout, because a wrong number here silently raises a
 * budget cap:
 *
 * - Nothing is estimated. An unpriced model, a timestamp before the price took
 *   effect, or a usage shape the table cannot bill returns `null` with a reason,
 *   never a guess.
 * - Prices are recorded in the currency they were published in. Converting CNY
 *   to the USD the caps are denominated in needs a rate, and inventing one
 *   would put a made-up multiplier under `maxCostUsdPerDay`.
 */

/** Tokens as a provider reports them, split the way prices are published. */
export interface TokenUsage {
  /** Input tokens served from the provider's prompt cache. */
  readonly cacheHitInput: number
  /** Input tokens the provider had to read. */
  readonly cacheMissInput: number
  readonly output: number
}

export type Currency = 'CNY'

/** CNY per 1M tokens, in the two bands DeepSeek publishes. */
interface RateCard {
  readonly cacheHitInput: number
  readonly cacheMissInput: number
  readonly output: number
}

interface PriceEntry {
  /** The model actually billed, which is not always the model requested. */
  readonly billedAs: string
  readonly currency: Currency
  /** Prices apply from this instant. Earlier dispatches are unpriced. */
  readonly effectiveFrom: number
  readonly peak: RateCard
  readonly offPeak: RateCard
  /** Why the billed model differs from the requested one, when it does. */
  readonly note?: string
}

export interface Price {
  readonly currency: Currency
  readonly amount: number
  readonly band: PeakBand
  readonly billedAs: string
  readonly note?: string
}

export type PriceFailure =
  | { readonly reason: 'unpriced_model'; readonly detail: string }
  | { readonly reason: 'before_effective_date'; readonly detail: string }
  | { readonly reason: 'unusable_usage'; readonly detail: string }

export type PriceResult =
  | { readonly ok: true; readonly price: Price }
  | { readonly ok: false } & PriceFailure

export type PeakBand = 'peak' | 'offPeak'

/** 2026-09-10 12:00 Beijing time (UTC+8), when the V4.1 Flash prices start. */
export const DEEPSEEK_V41_FLASH_EFFECTIVE_FROM = Date.UTC(2026, 8, 10, 4, 0, 0)

const DEEPSEEK_V41_FLASH: Omit<PriceEntry, 'billedAs' | 'note'> = {
  currency: 'CNY',
  effectiveFrom: DEEPSEEK_V41_FLASH_EFFECTIVE_FROM,
  peak: { cacheHitInput: 0.04, cacheMissInput: 2, output: 8 },
  offPeak: { cacheHitInput: 0.02, cacheMissInput: 1, output: 4 },
}

/**
 * Published prices, keyed by the model a route *requests*.
 *
 * `deepseek-v4-pro` is priced from the V4.1 Flash card on purpose: between V4.1
 * Flash shipping and V4.1 Pro shipping, DeepSeek routes V4 Pro requests to V4.1
 * Flash and bills them at Flash rates. The route keeps naming what it asks for;
 * the mapping to what is charged lives here. When V4.1 Pro ships this entry
 * stops being true and has to be revisited — which is why it carries a note
 * rather than silently sharing a card.
 *
 * `deepseek-flash` is V4.1 Flash's own API id (2026-09-10 notice); the
 * deprecated `deepseek-v4-flash` is routed to it and priced the same, with a
 * note, like V4 Pro. `deepseek-v4.1-flash` is kept for routes written before
 * the id was published.
 *
 * Models absent from this table are unpriced, not free.
 */
const PRICES: Readonly<Record<string, PriceEntry>> = {
  'deepseek-flash': { ...DEEPSEEK_V41_FLASH, billedAs: 'deepseek-flash' },
  'deepseek-v4.1-flash': { ...DEEPSEEK_V41_FLASH, billedAs: 'deepseek-flash' },
  'deepseek-v4-flash': {
    ...DEEPSEEK_V41_FLASH,
    billedAs: 'deepseek-flash',
    note: 'V4 Flash is deprecated; its id is routed to V4.1 Flash and billed at its prices',
  },
  'deepseek-v4-pro': {
    ...DEEPSEEK_V41_FLASH,
    billedAs: 'deepseek-flash',
    note: 'V4 Pro requests are routed to V4.1 Flash and billed at Flash prices until V4.1 Pro ships',
  },
}

export function isPricedModel(model: string): boolean {
  return Object.hasOwn(PRICES, model)
}

export function pricedModels(): readonly string[] {
  return Object.keys(PRICES)
}

const PEAK_WINDOWS: readonly (readonly [number, number])[] = [[9, 12], [14, 18]]
const BEIJING_OFFSET_MINUTES = 8 * 60

/**
 * Peak is Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time; everything else,
 * including all weekend hours, is off-peak.
 *
 * Beijing is a fixed UTC+8 with no daylight saving, so the offset is arithmetic
 * rather than a timezone database lookup — and it stays correct on a host in any
 * timezone, which a host-local `getHours()` would not.
 *
 * A window is half-open: 12:00 exactly is off-peak, which is how a boundary
 * stated as `9:00~12:00` alongside `14:00~18:00` has to read for the two not to
 * overlap the gap between them.
 */
export function peakBand(at: number): PeakBand {
  const beijing = new Date(at + BEIJING_OFFSET_MINUTES * 60_000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return 'offPeak'
  const hour = beijing.getUTCHours() + beijing.getUTCMinutes() / 60
  for (const [from, until] of PEAK_WINDOWS) {
    if (hour >= from && hour < until) return 'peak'
  }
  return 'offPeak'
}

const PER_MILLION = 1_000_000

/**
 * Price one dispatch. `at` is when it was billed, which decides the band, so
 * callers pass the dispatch's own time rather than the tick's.
 */
export function priceUsage(model: string, usage: TokenUsage, at: number): PriceResult {
  const entry = PRICES[model]
  if (!entry) {
    return { ok: false, reason: 'unpriced_model', detail: `no published price for ${model}` }
  }
  if (at < entry.effectiveFrom) {
    return {
      ok: false,
      reason: 'before_effective_date',
      detail: `${model} prices take effect at ${new Date(entry.effectiveFrom).toISOString()}`,
    }
  }
  const counts = [usage.cacheHitInput, usage.cacheMissInput, usage.output]
  if (counts.some(count => !Number.isFinite(count) || count < 0)) {
    return { ok: false, reason: 'unusable_usage', detail: 'token counts must be finite and non-negative' }
  }
  const band = peakBand(at)
  const card = entry[band]
  const amount = (
    usage.cacheHitInput * card.cacheHitInput
    + usage.cacheMissInput * card.cacheMissInput
    + usage.output * card.output
  ) / PER_MILLION
  return {
    ok: true,
    price: {
      currency: entry.currency,
      amount,
      band,
      billedAs: entry.billedAs,
      ...(entry.note === undefined ? {} : { note: entry.note }),
    },
  }
}

/** Total tokens, for the per-task token budget, which does not care about bands. */
export function totalTokens(usage: TokenUsage): number {
  return usage.cacheHitInput + usage.cacheMissInput + usage.output
}

/**
 * Convert a priced amount into the currency the caps are written in.
 *
 * `cnyPerUsd` of 0 means the operator has not set a rate, and the answer is
 * `null` rather than a number: a cost cap fed by a guessed exchange rate is a
 * cap at an unknown value. The CNY figure is still recorded, so an operator can
 * see the spend they cannot yet cap.
 */
export function toUsd(price: Price, cnyPerUsd: number): number | null {
  if (!Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0) return null
  return price.amount / cnyPerUsd
}
