import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema, resolveConfig, type BudgetLimits } from './config.js'
import { loadState, readBudgetSnapshot, saveState, withStateLock, workspaceArmed } from './persist.js'
import { writeProgress } from './progress.js'
import { diagnoseHalt, resumeState, type HaltDiagnosis, type ResumeOptions } from './resume.js'
import { applyAnswer, gateFor, type Gate, type GateOption } from './gate.js'

const USAGE = `devloop — inspect and unstick a DevLoop workspace

  devloop status [<root>]
  devloop answer <retry|review|accept|stop> [<root>]
  devloop resume [<root>] [--task <id>] [--reset-cost]

<root> defaults to the current directory.

status  Say whether the loop is halted, what decision it is waiting on, and
        which answers it can act on.
answer  Reply to that question. The loop asks it; this is how you speak back.
resume  Lift the halt and clear the circuits that are keyed on stale history.
        --task <id>    give that task another attempt, clearing its counters
        --reset-cost   also clear the spend windows (a cap is not a glitch,
                       so this never happens on its own)

A resumed workspace is not a running one: the plugin stops its timer when the
loop halts, so restart the DSH profile afterwards.
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
  if (command !== 'status' && command !== 'resume' && command !== 'answer') {
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
      outcome = await withStateLock(root, async () => {
        const now = Date.now()
        const current = await loadState(root, now)
        const gate = gateFor(current, budget.limits, now)
        if (gate === null) throw new Error('answer: the loop is not waiting on anything')
        const next = applyAnswer(current, gate, choice as GateOption['key'], now)
        const saved = await saveState(root, next, {
          expectedRevision: current.revision,
          action: `answer:${choice ?? ''}`,
        })
        try {
          await writeProgress(root, saved, now)
        } catch {
          fail('devloop: state saved but PROGRESS.md could not be rewritten\n')
        }
        return { gate, saved, declined: choice === 'stop' }
      })
    } catch (error) {
      fail(`devloop: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    if (!outcome.ok) {
      fail('devloop: another process holds the state lock; stop the profile and retry\n')
      return 1
    }
    const { gate, saved, declined } = outcome.value
    // `stop` lifts nothing on purpose, so it is not "still blocked" — it is the
    // answer. Exit 0 keeps a successful command distinguishable from a busy
    // lock or a failed save, both of which exit 1.
    if (declined) {
      write(`left halted: ${gate.reason} (recorded at revision ${saved.revision})\n`)
      return 0
    }
    write(`answered ${choice} for ${gate.reason} at revision ${saved.revision}\n`)
    const after = diagnoseHalt(saved, budget.limits, Date.now())
    if (after.wouldHaltAgain !== null) {
      write(`  still blocked by: ${after.wouldHaltAgain}\n`)
      return 1
    }
    write('restart the DSH profile to start ticking again\n')
    return 0
  }

  let outcome
  try {
    outcome = await withStateLock(root, async () => {
      const now = Date.now()
      const current = await loadState(root, now)
      // resumeState refuses an integrity hold; a synthesised empty state must
      // never be written over a STATE.json that merely failed to parse.
      const before = diagnoseHalt(current, budget.limits, now, options.resume)
      const next = resumeState(current, options.resume, now)
      const saved = await saveState(root, next, { expectedRevision: current.revision, action: 'resume' })
      // Derived and best-effort: STATE is already committed, and failing to
      // rewrite a human-readable snapshot must not report the recovery as failed.
      try {
        await writeProgress(root, saved, now)
      } catch {
        fail('devloop: state resumed but PROGRESS.md could not be rewritten\n')
      }
        return { saved, before }
    })
  } catch (error) {
    // A refusal is a result, not a crash: say why and leave STATE alone.
    fail(`devloop: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (!outcome.ok) {
    fail('devloop: another process holds the state lock; stop the profile and retry\n')
    return 1
  }

  const { saved, before } = outcome.value
  write(`resumed at revision ${saved.revision} (${budget.source})\n`)
  for (const reason of before.reasons) write(`  cleared: ${reason}\n`)
  const after = diagnoseHalt(saved, budget.limits, Date.now())
  if (after.wouldHaltAgain !== null) {
    write(`  still blocked by: ${after.wouldHaltAgain}\n`)
    write('  the loop will stop again on the next tick\n')
    return 1
  }
  write('restart the DSH profile to start ticking again\n')
  return 0
}

/**
 * The limits the running profile recorded, falling back to the defaults. A
 * diagnosis built on the wrong budget can claim a recovery that the service
 * then refuses, so which one was used is always printed.
 */
async function effectiveBudget(root: string): Promise<{ limits: BudgetLimits; source: string }> {
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
