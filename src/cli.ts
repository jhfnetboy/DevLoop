import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import { headlessPrompt, type HeadlessRunner } from './dsh.js'
import { defaultRunner } from './spawn.js'

const PLAN_TIMEOUT_MS = 45 * 60_000

function runTimeoutMs(input: AgentRunInput): number {
  return input.contract ? input.contract.budget.maxMinutes * 60_000 : PLAN_TIMEOUT_MS
}

function claudeArgv(input: AgentRunInput): string[] {
  const mode = input.action.type === 'plan' ? 'plan' : 'acceptEdits'
  return ['-p', '--permission-mode', mode, headlessPrompt(input)]
}

function codexArgv(input: AgentRunInput): string[] {
  const sandbox = input.action.type === 'plan' ? 'read-only' : 'workspace-write'
  return ['exec', '--sandbox', sandbox, headlessPrompt(input)]
}

async function runCli(
  runner: HeadlessRunner,
  command: string,
  argv: readonly string[],
  input: AgentRunInput,
  failLabel: string,
): Promise<AgentRunResult> {
  const cwd = input.worktreeRoot
  if (!cwd) {
    return { status: 'failed', detail: 'refusing to run T3 CLI at workspace root' }
  }
  try {
    await runner({ command, argv, cwd, timeoutMs: runTimeoutMs(input), signal: input.signal })
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
 * One-shot `claude -p --permission-mode … "<task>"` in a worktree.
 * Plan uses `plan` (read-only). Delegate/review use `acceptEdits`.
 */
export class ClaudeCliBackend implements AgentBackend {
  constructor(
    private readonly runner: HeadlessRunner = defaultRunner,
    private readonly command = 'claude',
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return runCli(this.runner, this.command, claudeArgv(input), input, 'claude cli failed')
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    return probeHelp(this.runner, this.command)
  }
}

/**
 * One-shot `codex exec --sandbox … "<task>"` in a worktree.
 * Plan uses `read-only`. Delegate/review use `workspace-write`.
 */
export class CodexCliBackend implements AgentBackend {
  constructor(
    private readonly runner: HeadlessRunner = defaultRunner,
    private readonly command = 'codex',
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return runCli(this.runner, this.command, codexArgv(input), input, 'codex exec failed')
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    return probeHelp(this.runner, this.command)
  }
}
