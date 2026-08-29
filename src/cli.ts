import { lstat, realpath, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import { headlessPrompt, type HeadlessRunner } from './dsh.js'
import { DEVLOOP_DIR } from './persist.js'
import { defaultRunner } from './spawn.js'

const PLAN_TIMEOUT_MS = 45 * 60_000

/** Constrained git + test Bash rules. Space before * is required prefix match. */
export const CLAUDE_DELEGATE_TOOLS = [
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(pnpm test *)',
].join(',')

function runTimeoutMs(input: AgentRunInput): number {
  return input.contract ? input.contract.budget.maxMinutes * 60_000 : PLAN_TIMEOUT_MS
}

function claudeArgv(input: AgentRunInput): string[] {
  const mode = input.action.type === 'delegate' ? 'acceptEdits' : 'plan'
  if (input.action.type !== 'delegate') {
    return ['-p', '--permission-mode', mode, cliPrompt(input)]
  }
  return ['-p', '--permission-mode', mode, '--allowedTools', CLAUDE_DELEGATE_TOOLS, cliPrompt(input)]
}

function workspaceGitDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.git')
}

function codexArgv(input: AgentRunInput): string[] {
  const sandbox = input.action.type === 'delegate' ? 'workspace-write' : 'read-only'
  if (input.action.type !== 'delegate') {
    return ['exec', '--sandbox', sandbox, cliPrompt(input)]
  }
  const gitDir = workspaceGitDir(input.workspaceRoot)
  return [
    'exec',
    '--sandbox',
    sandbox,
    '--add-dir',
    gitDir,
    '-c',
    `sandbox_workspace_write.writable_roots=${JSON.stringify([gitDir])}`,
    cliPrompt(input),
  ]
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

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function writeDevloopNote(workspaceRoot: string, filename: 'PLAN.md' | 'REVIEW.md', stdout: string): Promise<void> {
  const dir = join(workspaceRoot, DEVLOOP_DIR)
  const file = join(dir, filename)
  if (stdout.trim().length === 0) {
    try {
      const dirMeta = await lstat(dir)
      if (dirMeta.isSymbolicLink() || !dirMeta.isDirectory()) {
        throw new Error('refusing symlink .devloop')
      }
      const fileMeta = await lstat(file)
      if (fileMeta.isSymbolicLink()) throw new Error(`refusing symlink ${filename}`)
      await unlink(file)
    } catch (error) {
      if (!isEnoent(error)) throw error
    }
    return
  }
  const dirMeta = await lstat(dir)
  if (dirMeta.isSymbolicLink() || !dirMeta.isDirectory()) {
    throw new Error('refusing symlink .devloop')
  }
  try {
    const fileMeta = await lstat(file)
    if (fileMeta.isSymbolicLink()) throw new Error(`refusing symlink ${filename}`)
  } catch (error) {
    if (!isEnoent(error)) throw error
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
 * Plan and review use `plan` (read-only). Delegate uses `acceptEdits`
 * plus constrained `--allowedTools` so noninteractive `-p` can git-commit.
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
 * Plan and review use `read-only`. Delegate uses `workspace-write` and
 * adds the workspace `.git` to the writable scope (linked worktree metadata).
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
