import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema, resolveConfig, type BudgetLimits } from './config.js'
import { loadState, readBudgetSnapshot, workspaceArmed } from './persist.js'
import { diagnoseHalt, type HaltDiagnosis, type ResumeOptions } from './resume.js'
import { gateFor, type Gate, type GateOption } from './gate.js'
import { answerGate, OperatorError, pauseLoop, resumeLoop } from './operator.js'

const USAGE = `devloop — inspect and unstick a DevLoop workspace

  devloop status [<root>]
  devloop answer <retry|review|accept|stop> [<root>]
  devloop resume [<root>] [--task <id>] [--reset-cost]
  devloop pause [<root>]

<root> defaults to the current directory.

status  Say whether the loop is halted, what decision it is waiting on, and
        which answers it can act on.
answer  Reply to that question. The loop asks it; this is how you speak back.
resume  Lift the halt and clear the circuits that are keyed on stale history.
        --task <id>    give that task another attempt, clearing its counters
        --reset-cost   also clear the spend windows (a cap is not a glitch,
                       so this never happens on its own)
pause   Stop a loop that is running fine. Work in flight is abandoned and
        still counts as an attempt; resume picks the loop back up.

A running DSH profile notices an answer, a resume or a pause on its next tick;
nothing needs restarting.
`

export interface CliResult {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** Exported so the behaviour can be tested without paying for a subprocess. */
export async function runCli(
  argv: readonly string[],
  options: { readonly invokedAs?: string } = {},
): Promise<CliResult> {
  let out = ''
  let err = ''
  const write = (text: string): void => { out += text }
  const fail = (text: string): void => { err += text }
  const code = await main(argv, write, fail, options.invokedAs ?? selfInvocation())
  return { code, out, err }
}

/**
 * How to run this CLI again, spelled the way it was actually run.
 *
 * Nothing puts `devloop` on `PATH`: npm and pnpm do not link a package's own
 * `bin` into its own `node_modules/.bin`, and `dsh plugin add` does not either.
 * A gate whose whole purpose is to hand back the exact command to type must not
 * hand back one that cannot be typed, so it echoes the invocation it received.
 */
function selfInvocation(): string {
  // Derived from this module's own location rather than `process.argv[1]`:
  // argv is whatever started the process, which under a test runner or any
  // embedding host is not this CLI at all.
  const here = fileURLToPath(import.meta.url)
  return `node ${join(dirname(here), 'bin', `devloop${extname(here)}`)}`
}

async function main(
  argv: readonly string[],
  write: (text: string) => void,
  fail: (text: string) => void,
  invokedAs: string,
): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h') {
    write(USAGE)
    return command === undefined ? 2 : 0
  }
  if (command !== 'status' && command !== 'resume' && command !== 'answer' && command !== 'pause') {
    fail(`devloop: unknown command ${command}\n\n${USAGE}`)
    return 2
  }

  const options: { root: string; resume: ResumeOptions } = { root: '.', resume: {} }
  const positional: string[] = []
  let literal = false
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (literal) {
      if (arg !== undefined) positional.push(arg)
    } else if (arg === '--') {
      literal = true
    } else if (arg === '--task' || arg === '--reset-cost') {
      if (command !== 'resume') {
        fail(`devloop: ${arg} is only meaningful for resume\n`)
        return 2
      }
      if (arg === '--reset-cost') {
        options.resume = { ...options.resume, resetCost: true }
        continue
      }
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('-')) {
        fail('devloop: --task needs a task id\n')
        return 2
      }
      options.resume = { ...options.resume, taskId: value }
      i += 1
    } else if (arg !== undefined && arg.startsWith('-')) {
      fail(`devloop: unknown option ${arg}\n`)
      return 2
    } else if (arg !== undefined) {
      positional.push(arg)
    }
  }
  let choice: GateOption['key'] | undefined
  if (command === 'answer') {
    const given = positional.shift()
    if (given === undefined) {
      fail('devloop: answer needs one of retry, review, accept, stop\n')
      return 2
    }
    if (given !== 'retry' && given !== 'review' && given !== 'accept' && given !== 'stop') {
      fail(`devloop: ${given} is not an answer; use retry, review, accept or stop\n`)
      return 2
    }
    choice = given
  }
  if (positional.length > 1) {
    fail('devloop: expected at most one <root>\n')
    return 2
  }
  const root = resolve(positional[0] ?? options.root)

  if (!await workspaceArmed(root)) {
    fail(`devloop: ${root} has no .devloop/GOAL.md\n`)
    return 1
  }
  const budget = await effectiveBudget(root)

  if (command === 'status') {
    const now = Date.now()
    const state = await loadState(root, now)
    const diagnosis = diagnoseHalt(state, budget.limits, now, options.resume)
    write(render(state.revision, diagnosis, budget.source, gateFor(state, budget.limits, now), invokedAs, root))
    // Non-zero for a loop that is stopped *or* that would stop on its next
    // tick: both need a human, and only one of them is visible in STATE.
    return diagnosis.halted || diagnosis.wouldHaltAgain !== null ? 1 : 0
  }

  if (command === 'answer') {
    let outcome
    try {
      outcome = await answerGate(root, choice as GateOption['key'], budget.limits, { via: 'cli' })
    } catch (error) {
      fail(`devloop: ${operatorMessage(error)}\n`)
      return 1
    }
    if (!outcome.progressWritten) fail('devloop: state saved but PROGRESS.md could not be rewritten\n')
    const { gate, saved, declined } = outcome
    // `stop` lifts nothing on purpose, so it is not "still blocked" — it is the
    // answer. Exit 0 keeps a successful command distinguishable from a busy
    // lock or a failed save, both of which exit 1.
    if (declined) {
      write(`left halted: ${gate.reason} (recorded at revision ${saved.revision})\n`)
      return 0
    }
    write(`answered ${choice} for ${gate.reason} at revision ${saved.revision}\n`)
    if (outcome.stillBlocked !== null) {
      write(`  still blocked by: ${outcome.stillBlocked}\n`)
      return 1
    }
    write(RESUMES_ON_NEXT_TICK)
    return 0
  }

  if (command === 'pause') {
    let outcome
    try {
      outcome = await pauseLoop(root, budget.limits, { via: 'cli' })
    } catch (error) {
      fail(`devloop: ${operatorMessage(error)}\n`)
      return 1
    }
    if (!outcome.progressWritten) fail('devloop: state saved but PROGRESS.md could not be rewritten\n')
    write(`paused at revision ${outcome.saved.revision}\n`)
    write(`  resume with: ${invokedAs} resume ${root}\n`)
    return 0
  }

  let outcome
  try {
    outcome = await resumeLoop(root, options.resume, budget.limits, { via: 'cli' })
  } catch (error) {
    // A refusal is a result, not a crash: say why and leave STATE alone.
    fail(`devloop: ${operatorMessage(error)}\n`)
    return 1
  }
  // Derived and best-effort: STATE is already committed, and failing to
  // rewrite a human-readable snapshot must not report the recovery as failed.
  if (!outcome.progressWritten) fail('devloop: state resumed but PROGRESS.md could not be rewritten\n')

  const { saved, before } = outcome
  write(`resumed at revision ${saved.revision} (${budget.source})\n`)
  for (const reason of before.reasons) write(`  cleared: ${reason}\n`)
  if (outcome.stillBlocked !== null) {
    write(`  still blocked by: ${outcome.stillBlocked}\n`)
    write('  the loop will stop again on the next tick\n')
    return 1
  }
  write(RESUMES_ON_NEXT_TICK)
  return 0
}

/**
 * The CLI cannot see whether a profile is running — it is a separate process —
 * so it says what happens in both cases rather than guessing which one holds.
 */
const RESUMES_ON_NEXT_TICK = 'a running DSH profile picks this up on its next tick; start one if none is running\n'

function operatorMessage(error: unknown): string {
  if (error instanceof OperatorError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * The limits the running profile recorded, falling back to the defaults. A
 * diagnosis built on the wrong budget can claim a recovery that the service
 * then refuses, so which one was used is always printed.
 */
export async function effectiveBudget(root: string): Promise<{ limits: BudgetLimits; source: string }> {
  const snapshot = await readBudgetSnapshot(root)
  if (snapshot === null) return { limits: resolveConfig({ root }).budget, source: 'default budgets' }
  try {
    return {
      limits: ConfigSchema({ root, budget: snapshot } as never).budget,
      source: 'profile budgets',
    }
  } catch {
    return { limits: resolveConfig({ root }).budget, source: 'default budgets (BUDGET.json unreadable)' }
  }
}

function render(
  revision: number,
  diagnosis: HaltDiagnosis,
  source: string,
  gate: Gate | null,
  invokedAs: string,
  root: string,
): string {
  const lines = [`revision ${revision} (${source})`]
  if (!diagnosis.halted) {
    lines.push('not halted')
  } else {
    lines.push('halted:')
    for (const reason of diagnosis.reasons) lines.push(`  ${reason}`)
  }
  if (diagnosis.integrityHold !== null) {
    lines.push(`STATE.json cannot be trusted; repair it before resuming`)
    // The gate still prints: an integrity hold is the one halt no answer can
    // lift, so its recovery instructions are the only guidance there is.
    return `${[...lines, ...gateLines(gate, invokedAs, root)].join('\n')}\n`
  }
  if (diagnosis.wouldHaltAgain !== null) {
    lines.push(`resuming as-is would stop again: ${diagnosis.wouldHaltAgain}`)
    if (diagnosis.taskId !== null) lines.push(`  try: ${invokedAs} resume ${root} --task ${diagnosis.taskId}`)
  } else if (diagnosis.halted) {
    lines.push('resuming would let the loop continue')
  }
  return `${[...lines, ...gateLines(gate, invokedAs, root)].join('\n')}\n`
}

function gateLines(gate: Gate | null, invokedAs: string, root: string): string[] {
  if (gate === null) return []
  const lines = ['', gate.question]
  for (const item of gate.evidence) lines.push(`  - ${item}`)
  for (const option of gate.options) {
    lines.push(`  ${invokedAs} answer ${option.key.padEnd(6)} ${root}   ${option.summary}`)
  }
  if (gate.manual !== null) lines.push(`  by hand: ${gate.manual}`)
  return lines
}
