import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'

const execFileAsync = promisify(execFile)

export interface HeadlessRun {
  readonly command: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export type HeadlessRunner = (request: HeadlessRun) => Promise<{ stdout: string, stderr: string }>

export function headlessPrompt(input: AgentRunInput): string {
  if (input.action.type === 'plan') {
    return 'Read .devloop/GOAL.md and produce a bounded task list. Do not edit business source files.'
  }
  if (input.action.type === 'review' && input.contract) {
    return `Review task ${input.contract.taskId} (${input.contract.title}). Verdict must be PASS, REWORK, or BLOCKED. Acceptance: ${input.contract.acceptance.join('; ')}`
  }
  if (input.contract) {
    return [
      `Execute task ${input.contract.taskId}: ${input.contract.title}.`,
      `Allowed paths: ${input.contract.allowedPaths.join(', ')}.`,
      `Forbidden: ${input.contract.forbidden.join(', ')}.`,
      `Acceptance: ${input.contract.acceptance.join('; ')}.`,
      'Read .devloop/CONTRACT.json. Do not modify .devloop/.',
    ].join(' ')
  }
  return 'Follow the DevLoop task contract in this workspace.'
}

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

/**
 * One-shot `dsh --profile headless "<task>"` in the worktree (or workspace).
 */
export class DshHeadlessBackend implements AgentBackend {
  constructor(
    private readonly runner: HeadlessRunner = defaultRunner,
    private readonly command = 'dsh',
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const cwd = input.worktreeRoot ?? input.workspaceRoot
    const timeoutMs = input.contract
      ? input.contract.budget.maxMinutes * 60_000
      : 45 * 60_000
    try {
      await this.runner({
        command: this.command,
        argv: ['--profile', 'headless', headlessPrompt(input)],
        cwd,
        timeoutMs,
        signal: input.signal,
      })
      return { status: 'started' }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'dsh headless failed'
      return { status: 'failed', detail }
    }
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    try {
      await this.runner({
        command: this.command,
        argv: ['--help'],
        cwd: process.cwd(),
        timeoutMs: 5_000,
      })
      return 'ok'
    } catch {
      return 'down'
    }
  }
}
