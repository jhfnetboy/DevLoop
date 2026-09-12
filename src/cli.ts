import { constants, lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import { headlessPrompt, type HeadlessRunner } from './dsh.js'
import { assertLocalDevloopDir, DEVLOOP_DIR } from './persist.js'
import { defaultRunner } from './spawn.js'
import { parseDevloopResult, protocolRepairInstruction } from './result.js'
import { readClaudeJson, readCodexJsonl, type ReadCliOutput } from './reading.js'

const PLAN_TIMEOUT_MS = 45 * 60_000

function runTimeoutMs(input: AgentRunInput): number {
  return input.contract ? input.contract.budget.maxMinutes * 60_000 : PLAN_TIMEOUT_MS
}

function claudeArgv(input: AgentRunInput): string[] {
  const mode = input.action.type === 'delegate' ? 'acceptEdits' : 'plan'
  const model = input.route ? ['--model', input.route.model] : []
  // --output-format json is what carries usage and total_cost_usd; without it
  // the run is invisible to the budget.
  const shape = ['--output-format', 'json']
  if (input.action.type !== 'delegate') {
    return ['-p', ...model, ...shape, '--permission-mode', mode, cliPrompt(input)]
  }
  return ['-p', ...model, ...shape, '--permission-mode', mode, '--', cliPrompt(input)]
}


async function codexArgv(input: AgentRunInput): Promise<string[]> {
  const sandbox = input.action.type === 'delegate' ? 'workspace-write' : 'read-only'
  // --json prints one event per line, including turn.completed.usage.
  const argv = ['exec', '--json', '--sandbox', sandbox]
  if (input.route) argv.push('--model', input.route.model)
  if (input.action.type !== 'delegate') {
    argv.push(cliPrompt(input))
    return argv
  }
  // No --add-dir for the gitdir: the host commits, and a worker that can write there can point
  // the host's own git at a repository whose config runs a program (commondir → core.fsmonitor).
  argv.push(cliPrompt(input))
  return argv
}

function cliPrompt(input: AgentRunInput): string {
  const base = headlessPrompt(input)
  if (input.action.type === 'delegate') {
    return `${base}\nEdit files in this worktree only. Do not run git. The host commits the task branch.`
  }
  if (input.action.type === 'review') {
    return `${base}\nDo not edit files. Verdict only.`
  }
  return base
}

async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right)
  } catch {
    return left === right
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function writeDevloopNote(workspaceRoot: string, filename: 'PLAN.md' | 'REVIEW.md', stdout: string): Promise<void> {
  const dir = join(workspaceRoot, DEVLOOP_DIR)
  const file = join(dir, filename)
  await assertLocalDevloopDir(workspaceRoot)
  if (stdout.trim().length === 0) {
    try {
      const fileMeta = await lstat(file)
      if (fileMeta.isSymbolicLink()) throw new Error(`refusing symlink ${filename}`)
      await unlink(file)
    } catch (error) {
      if (!isEnoent(error)) throw error
    }
    return
  }
  try {
    const fileMeta = await lstat(file)
    if (fileMeta.isSymbolicLink()) throw new Error(`refusing symlink ${filename}`)
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
  const temp = join(dir, `.${filename}.${String(process.pid)}.${String(Date.now())}.tmp`)
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    const handle = await open(temp, flags, 0o600)
    try {
      await handle.writeFile(stdout.endsWith('\n') ? stdout : `${stdout}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

async function runCli(
  runner: HeadlessRunner,
  command: string,
  argv: readonly string[],
  repairArgv: readonly string[],
  input: AgentRunInput,
  failLabel: string,
  read: ReadCliOutput,
): Promise<AgentRunResult> {
  const cwd = input.worktreeRoot
  if (!cwd || await samePath(cwd, input.workspaceRoot)) {
    return { status: 'failed', detail: 'refusing to run T3 CLI at workspace root', reachedProvider: false }
  }
  try {
    const request = { command, argv, cwd, timeoutMs: runTimeoutMs(input), signal: input.signal }
    // Both counters accumulate across the repair attempt: a run that had to be
    // asked twice cost twice, and the budget must see both.
    let tokens: number | undefined
    let costUsd: number | undefined
    const bank = (reading: { tokens?: number; costUsd?: number }): void => {
      if (reading.tokens !== undefined) tokens = (tokens ?? 0) + reading.tokens
      if (reading.costUsd !== undefined) costUsd = (costUsd ?? 0) + reading.costUsd
    }

    let reading = read((await runner(request)).stdout)
    bank(reading)
    let outcome
    if (reading.text.includes('<devloop_result>')) {
      try {
        outcome = parseDevloopResult(reading.text)
      } catch {
        const repaired = [...repairArgv]
        const promptIndex = repaired.length - 1
        repaired[promptIndex] = `${repaired[promptIndex] ?? ''}\n${protocolRepairInstruction()}`
        reading = read((await runner({ ...request, argv: repaired })).stdout)
        bank(reading)
        outcome = reading.text.includes('<devloop_result>') ? parseDevloopResult(reading.text) : undefined
      }
    }
    // The notes are for a human, so they get the prose, not the transport.
    if (input.action.type === 'plan') {
      await writeDevloopNote(input.workspaceRoot, 'PLAN.md', reading.text)
    } else if (input.action.type === 'review') {
      await writeDevloopNote(input.workspaceRoot, 'REVIEW.md', reading.text)
    }
    return {
      status: 'started',
      ...(outcome === undefined ? {} : { outcome }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(input.route ? { agent: `${input.route.backend}/${input.route.model}` } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : failLabel
    return { status: 'failed', detail }
  }
}

async function probeHelp(runner: HeadlessRunner, command: string): Promise<'ok' | 'down'> {
  try {
    await runner({
      command,
      argv: ['--help'],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    })
    return 'ok'
  } catch {
    return 'down'
  }
}

/**
 * One-shot `claude -p --permission-mode … "<task>"` in a worktree.
 * Plan and review use `plan` (read-only). Delegate uses `acceptEdits`
 * plus `--` before the prompt. No Bash auto-approve; git stays on the host.
 */
export class ClaudeCliBackend implements AgentBackend {
  constructor(
    private readonly runner: HeadlessRunner = defaultRunner,
    private readonly command = 'claude',
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const argv = claudeArgv(input)
    return runCli(this.runner, this.command, argv, claudeRepairArgv(argv), input, 'claude cli failed', readClaudeJson)
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    return probeHelp(this.runner, this.command)
  }
}

/**
 * One-shot `codex exec --sandbox … "<task>"` in a worktree.
 * Plan and review use `read-only`. Delegate uses `workspace-write` on the
 * worktree alone, never its gitdir. The host commits dirty task worktrees after
 * a successful started run, with hooks disabled and its git directories pinned.
 */
export class CodexCliBackend implements AgentBackend {
  constructor(
    private readonly runner: HeadlessRunner = defaultRunner,
    private readonly command = 'codex',
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const argv = await codexArgv(input)
    return runCli(this.runner, this.command, argv, codexRepairArgv(argv), input, 'codex exec failed', readCodexJsonl)
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    return probeHelp(this.runner, this.command)
  }
}

function claudeRepairArgv(argv: readonly string[]): string[] {
  const repaired = [...argv]
  const mode = repaired.indexOf('--permission-mode')
  if (mode >= 0) repaired[mode + 1] = 'plan'
  return repaired
}

function codexRepairArgv(argv: readonly string[]): string[] {
  const repaired: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--add-dir') {
      index += 1
      continue
    }
    if (argv[index] === '--sandbox') {
      repaired.push('--sandbox', 'read-only')
      index += 1
      continue
    }
    repaired.push(argv[index]!)
  }
  return repaired
}
