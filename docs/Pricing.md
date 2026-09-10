# Prices

What a dispatch costs, and why the loop can only partly charge for it.

## DeepSeek V4.1 Flash

In effect from **2026-09-10 12:00 Beijing time (UTC+8)**. CNY per 1M tokens.

| | Off-peak | Peak |
|---|---|---|
| Input, cache hit | ¥0.02 | ¥0.04 |
| Input, cache miss | ¥1 | ¥2 |
| Output | ¥4 | ¥8 |

**Peak** is Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time. Everything else is
off-peak, including every weekend hour. The two windows are stated as
`9:00~12:00` and `14:00~18:00`, so each is half-open: 12:00 is off-peak, and the
gap between them is off-peak. Beijing has no daylight saving, so `peakBand()` is
arithmetic on a fixed UTC+8 offset rather than a timezone lookup — a host in any
timezone gets the same answer, which `getHours()` would not.

Peak output costs 200× peak cached input. A workload that reads a large cached
prompt and writes little is nearly free; one that writes a lot is not. Shifting
long dispatches out of the two weekday windows halves them.

## `deepseek-v4-pro` bills as Flash

Between V4.1 Flash shipping and **V4.1 Pro** shipping, DeepSeek routes V4 Pro
requests to V4.1 Flash and bills them at Flash prices. So `routing.T2`, which
names `deepseek-v4-pro`, is priced from the table above.

The route keeps naming what it asks for and the price table holds the mapping to
what is charged. Rewriting the route to `deepseek-v4.1-flash` would lose the fact
that we asked for Pro, which is what has to be revisited the day V4.1 Pro ships —
and until then T1 and T2 land on comparable models, so do not reason about T2 as
the more expensive tier.

## What is not priced

`pricedModels()` is the whole table. Two absences are deliberate:

- **`deepseek-v4-flash`**, which `routing.T1` names, has no published rate in the
  notice this table was built from.
- **V4 Pro's own pre-change rates** were not restated, so a dispatch billed
  before the effective date above is unpriced rather than priced at today's card.

Both return `{ ok: false, reason }` from `priceUsage`. An unpriced model is not a
free one, and a cost cap fed by a guessed price is a cap at an unknown value.

## The gap between a price and a charge

`priceUsage` needs input tokens split by cache hit and miss, and output tokens
separately — a 200× spread at peak, so a single total cannot be billed.
`BackendResult` carries `tokens?: number`, one scalar, and
`DshHeadlessBackend` fills neither it nor `costUsd`: `dsh --profile headless`
has no output options, so there is nothing to read but prose.

So the table above has no caller yet. Closing that needs the token split at the
source, which means a usage feed rather than a parsed CLI transcript — tracked as
A4 in [Research-dsh-devtools.md](Research-dsh-devtools.md): a `session/event`
tap on `HarnessSubagentBackend`, which already runs providers in process on the
same cordis context.

## Currency

Prices are published in CNY; `maxCostUsdPerSession` and `maxCostUsdPerDay` are in
USD. `toUsd(price, cnyPerUsd)` converts only when an operator supplies a rate,
and returns `null` otherwise rather than putting a made-up multiplier under a
budget cap. Recording CNY spend in `BudgetUsage` would add fields to persisted
state and so a `STATE_VERSION` bump, which no dispatch needs yet.
