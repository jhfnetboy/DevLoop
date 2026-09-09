import { defaultRunner, type HeadlessRunner } from './spawn.js'

/**
 * A command the operator trusts, run against a finished task before it is
 * offered for review.
 *
 * Given as argv rather than a shell string: there is no shell, so nothing in a
 * path or a task title can turn into another command.
 */
export type AcceptanceCheck = readonly string[]

export interface AcceptanceFailure {
  readonly argv: readonly string[]
  readonly detail: string
}

const MAX_DETAIL = 4_000

export function assertAcceptanceChecks(checks: readonly AcceptanceCheck[]): void {
  if (!Array.isArray(checks)) throw new Error('acceptance: checks must be a list')
  for (const check of checks) {
    if (!Array.isArray(check) || check.length === 0) {
      throw new Error('acceptance: each check must be a non-empty argv list')
    }
    for (const part of check) {
      if (typeof part !== 'string' || part.length === 0) {
        throw new Error('acceptance: argv entries must be non-empty strings')
      }
    }
    const command = check[0] ?? ''
    // A leading dash would make the command itself read as an option to
    // whatever ends up running it.
    if (command.startsWith('-')) throw new Error(`acceptance: ${command} is not a command`)
  }
}

/**
 * Run the operator's checks in the task's worktree.
 *
 * This is the one place the host executes what a worker produced. A task's own
 * claim to be finished is a claim; `pnpm test` reading files the worker wrote is
 * evidence. The distinction is the whole reason for running them: the loop
 * otherwise advances on the model's word.
 *
 * The trade is explicit rather than hidden. Running the project's tests runs
 * code the worker wrote, so this is off until an operator lists commands they
 * are willing to have run that way — the same trust as typing them by hand.
 *
 * The first failure wins: later checks add nothing once the task is going back.
 */
export async function runAcceptanceChecks(
  worktreeRoot: string,
  checks: readonly AcceptanceCheck[],
  timeoutMs: number,
  signal?: AbortSignal,
  runner: HeadlessRunner = defaultRunner,
): Promise<AcceptanceFailure | null> {
  for (const check of checks) {
    const [command, ...args] = check
    if (command === undefined) continue
    try {
      await runner({
        command,
        argv: args,
        cwd: worktreeRoot,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      return {
        argv: check,
        detail: truncate(error instanceof Error ? error.message : 'acceptance check failed'),
      }
    }
  }
  return null
}

/** A failing suite prints a great deal; a hold reason has to stay readable. */
function truncate(detail: string): string {
  return detail.length <= MAX_DETAIL ? detail : `${detail.slice(0, MAX_DETAIL)}…`
}
