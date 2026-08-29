import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import { headlessPrompt, type HeadlessRun, type HeadlessRunner } from './dsh.js'

const execFileAsync = promisify(execFile)

async function defaultRunner(request: HeadlessRun): Promise<{ stdout: string, stderr: string }> {
  const { stdout, stderr } = await execFileAsync(request.command, [...request.argv], {
    cwd: request.cwd,
    timeout: request.timeoutMs,
    encoding: 'utf8',
    signal: request.signal,
    maxBuffer: 10 * 1024 * 1024,
  })
  return { stdout, stderr }
}

async function runCli(
  runner: HeadlessRunner,
  command: string,
  argv: readonly string[],
  input: AgentRunInput,
  failLabel: string,
): Promise<AgentRunResult> {
  const cwd = input.worktreeRoot ?? input.workspaceRoot
  const timeoutMs = input.contract
    ? input.contract.budget.maxMinutes * 60_000
    : 45 * 60_000
  try {
    await runner({ command, argv, cwd, timeoutMs, signal: input.signal })
    return { status: 'started' }
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
 * One-shot `claude -p "<task>"` in the worktree (or workspace).
 */
export class ClaudeCliBackend implements AgentBackend {
  constructor(
    private readonly runner: HeadlessRunner = defaultRunner,
    private readonly command = 'claude',
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return runCli(
      this.runner,
      this.command,
      ['-p', headlessPrompt(input)],
      input,
      'claude cli failed',
    )
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    return probeHelp(this.runner, this.command)
  }
}

/**
 * One-shot `codex exec "<task>"` in the worktree (or workspace).
 */
export class CodexCliBackend implements AgentBackend {
  constructor(
    private readonly runner: HeadlessRunner = defaultRunner,
    private readonly command = 'codex',
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return runCli(
      this.runner,
      this.command,
      ['exec', headlessPrompt(input)],
      input,
      'codex exec failed',
    )
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    return probeHelp(this.runner, this.command)
  }
}
