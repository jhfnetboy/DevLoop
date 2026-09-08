/**
 * What a T3 CLI actually reports back, once its own output format is unwrapped.
 *
 * The prose is what the envelope parser and the operator-facing notes need; the
 * counters are what makes `maxCostUsdPerDay` more than decoration. Not every
 * CLI offers all three, and a reader says so by leaving a field out rather than
 * reporting a zero: a zero would fold into the budget as "this run was free".
 */
export interface CliReading {
  readonly text: string
  readonly tokens?: number
  readonly costUsd?: number
}

export type ReadCliOutput = (stdout: string) => CliReading

/** A CLI that reports nothing but its prose. */
export const readPlainOutput: ReadCliOutput = stdout => ({ text: stdout })

/**
 * `claude -p --output-format json` wraps the reply in one object and reports
 * both token counts and a settled price.
 *
 * Falls back to the raw text when the envelope is missing or malformed: losing
 * a cost signal is a smaller harm than losing the model's answer.
 */
export const readClaudeJson: ReadCliOutput = stdout => {
  const parsed = parseJson(stdout)
  if (parsed === undefined || typeof parsed.result !== 'string') return { text: stdout }
  const tokens = claudeTokens(parsed.usage)
  const costUsd = finitePositive(parsed.total_cost_usd) ? parsed.total_cost_usd : undefined
  return {
    text: parsed.result,
    ...(tokens === undefined ? {} : { tokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  }
}

/**
 * `codex exec --json` prints one JSON object per line. The reply is the last
 * completed agent message; the counters arrive on `turn.completed`.
 *
 * Codex reports tokens but no price, so no cost signal is invented for it — a
 * fabricated one would spend a real budget.
 */
export const readCodexJsonl: ReadCliOutput = stdout => {
  let text: string | undefined
  let tokens: number | undefined
  for (const line of stdout.split('\n')) {
    const event = parseJson(line)
    if (event === undefined) continue
    if (event.type === 'item.completed') {
      const item = asRecord(event.item)
      if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text
    }
    if (event.type === 'turn.completed') {
      const counted = codexTokens(event.usage)
      if (counted !== undefined) tokens = (tokens ?? 0) + counted
    }
  }
  // Without a recognisable message the raw output is still the best evidence
  // for the operator, and for the envelope parser to fail loudly on.
  return { text: text ?? stdout, ...(tokens === undefined ? {} : { tokens }) }
}

/**
 * Everything the model read plus everything it wrote. Cache hits are counted:
 * they are cheaper, not free, and the price is taken from `total_cost_usd`
 * anyway — this number guards `maxTokensPerTask`, which is about how much
 * context one task is allowed to consume.
 */
function claudeTokens(value: unknown): number | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const parts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.output_tokens,
  ].filter(finiteNonNegative)
  return parts.length === 0 ? undefined : parts.reduce((total, part) => total + part, 0)
}

/** `cached_input_tokens` is part of `input_tokens`, so counting both would double. */
function codexTokens(value: unknown): number | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const parts = [usage.input_tokens, usage.output_tokens].filter(finiteNonNegative)
  return parts.length === 0 ? undefined : parts.reduce((total, part) => total + part, 0)
}

function parseJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
