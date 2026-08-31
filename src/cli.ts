import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import { headlessPrompt, type HeadlessRunner } from './dsh.js'
import { DEVLOOP_DIR } from './persist.js'
import { defaultRunner } from './spawn.js'
import { parseDevloopResult } from './result.js'

const PLAN_TIMEOUT_MS = 45 * 60_000

function runTimeoutMs(input: AgentRunInput): number {
  return input.contract ? input.contract.budget.maxMinutes * 60_000 : PLAN_TIMEOUT_MS
}

function claudeArgv(input: AgentRunInput): string[] {
  const mode = input.action.type === 'delegate' ? 'acceptEdits' : 'plan'
  const model = input.route ? ['--model', input.route.model] : []
  if (input.action.type !== 'delegate') {
    return ['-p', ...model, '--permission-mode', mode, cliPrompt(input)]
  }
  return ['-p', ...model, '--permission-mode', mode, '--', cliPrompt(input)]
}

async function resolveLinkedGitDir(input: AgentRunInput): Promise<string | null> {
  if (!input.worktreeRoot) return null
  try {
    const marker = await readFile(join(input.worktreeRoot, '.git'), 'utf8')
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(marker)
    if (match?.[1]) {
      const raw = match[1]
      return isAbsolute(raw) ? raw : join(input.worktreeRoot, raw)
    }
  } catch {
    // Missing, unreadable, or a real .git directory.
  }
  return join(input.workspaceRoot, '.git', 'worktrees', basename(input.worktreeRoot))
}

async function codexArgv(input: AgentRunInput): Promise<string[]> {
  const sandbox = input.action.type === 'delegate' ? 'workspace-write' : 'read-only'
  const argv = ['exec', '--sandbox', sandbox]
  if (input.route) argv.push('--model', input.route.model)
  if (input.action.type !== 'delegate') {
    argv.push(cliPrompt(input))
    return argv
  }
  const gitDir = await resolveLinkedGitDir(input)
  if (gitDir) argv.push('--add-dir', gitDir)
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
    const outcome = stdout.includes('<devloop_result>') ? parseDevloopResult(stdout) : undefined
    return {
      status: 'started',
      ...(outcome === undefined ? {} : { outcome }),
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
 * `--add-dir` of the worktree's real gitdir (from `.git` gitdir: file). The host
 * commits dirty task worktrees after a successful started run, with hooks disabled.
 */
export class CodexCliBackend implements AgentBackend {
  constructor(
    private readonly runner: HeadlessRunner = defaultRunner,
    private readonly command = 'codex',
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return runCli(this.runner, this.command, await codexArgv(input), input, 'codex exec failed')
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    return probeHelp(this.runner, this.command)
  }
}
