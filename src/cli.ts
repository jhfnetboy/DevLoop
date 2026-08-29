import { lstat, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import { headlessPrompt, type HeadlessRunner } from './dsh.js'
import { DEVLOOP_DIR } from './persist.js'
import { defaultRunner } from './spawn.js'

const PLAN_TIMEOUT_MS = 45 * 60_000

function runTimeoutMs(input: AgentRunInput): number {
  return input.contract ? input.contract.budget.maxMinutes * 60_000 : PLAN_TIMEOUT_MS
}

function claudeArgv(input: AgentRunInput): string[] {
  const mode = input.action.type === 'delegate' ? 'acceptEdits' : 'plan'
  return ['-p', '--permission-mode', mode, cliPrompt(input)]
}

function codexArgv(input: AgentRunInput): string[] {
  const sandbox = input.action.type === 'delegate' ? 'workspace-write' : 'read-only'
  return ['exec', '--sandbox', sandbox, cliPrompt(input)]
}

function cliPrompt(input: AgentRunInput): string {
  const base = headlessPrompt(input)
  if (input.action.type === 'delegate') {
    return `${base}\nCommit validated changes on this task branch before exiting. Do not leave a dirty worktree.`
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

async function writeDevloopNote(workspaceRoot: string, filename: 'PLAN.md' | 'REVIEW.md', stdout: string): Promise<void> {
  if (stdout.trim().length === 0) return
  const dir = join(workspaceRoot, DEVLOOP_DIR)
  const dirMeta = await lstat(dir)
  if (dirMeta.isSymbolicLink() || !dirMeta.isDirectory()) {
    throw new Error('refusing symlink .devloop')
  }
  const file = join(dir, filename)
  try {
    const fileMeta = await lstat(file)
    if (fileMeta.isSymbolicLink()) throw new Error(`refusing symlink ${filename}`)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  await writeFile(file, stdout.endsWith('\n') ? stdout : `${stdout}\n`, 'utf8')
}

async function runCli(
  runner: HeadlessRunner,
  command: string,
  argv: readonly string[],
  input: AgentRunInput,
  failLabel: string,
): Promise<AgentRunResult> {
  const cwd = input.worktreeRoot
  if (!cwd || await samePath(cwd, input.workspaceRoot)) {
    return { status: 'failed', detail: 'refusing to run T3 CLI at workspace root' }
  }
  try {
    const { stdout } = await runner({ command, argv, cwd, timeoutMs: runTimeoutMs(input), signal: input.signal })
    if (input.action.type === 'plan') {
      await writeDevloopNote(input.workspaceRoot, 'PLAN.md', stdout)
    } else if (input.action.type === 'review') {
      await writeDevloopNote(input.workspaceRoot, 'REVIEW.md', stdout)
    }
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
 * Plan and review use `plan` (read-only). Delegate uses `acceptEdits`.
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
 * Plan and review use `read-only`. Delegate uses `workspace-write`.
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
