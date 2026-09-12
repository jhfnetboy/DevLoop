import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import { defaultRunner, type HeadlessRun, type HeadlessRunner } from './spawn.js'
import { parseDevloopResult, protocolRepairInstruction, resultInstructions } from './result.js'
import { readPlainOutput } from './reading.js'

export type { HeadlessRun, HeadlessRunner }

/**
 * What an existing repository already says about itself, named rather than
 * inlined: every backend's planner can read files, and a digest taken here would
 * go stale the moment the documents changed. The planning directory is the one
 * the pilot skill writes; this reads its output, and never needs the skill.
 */
export const PLAN_CONTEXT = [
  'Before planning, read whichever of these exist and plan within them:',
  'AGENTS.md and CLAUDE.md (how this repository is built, tested and reviewed);',
  '.pilot.yml (docs_dir names the planning directory, default docs/agent);',
  'roadmap.md, tasks.md, progress.md, architecture.md and spec.md in that directory (the plan already agreed).',
  'Where tasks.md already defines a task, reuse its id and its acceptance commands rather than inventing new ones,',
  'and do not plan work those documents mark DONE or out of scope.',
  'If GOAL.md and those documents disagree, GOAL.md wins.',
  // Said here, at planning time: the pre-PR checker refuses a bigger change after
  // the worker has been paid, and the only answer then is to split the task.
  'Size every task to fit one reviewable pull request: at most 200 changed lines (additions plus deletions,',
  'not counting lockfiles or generated files), at most 5 files, at most 2 top-level directories (tests and docs',
  'do not count toward directories). Give CI, git hooks, dependency manifests, migrations and money or security',
  'code tasks of their own. A larger change is refused before review, so split it into tasks now.',
].join(' ')

export function headlessPrompt(input: AgentRunInput): string {
  if (input.action.type === 'plan') {
    return [
      'Read .devloop/GOAL.md and produce a bounded task list. Do not edit business source files.',
      PLAN_CONTEXT,
      resultInstructions('plan'),
    ].join('\n')
  }
  if (input.action.type === 'review' && input.contract) {
    return [
      `Review task ${input.contract.taskId} (${input.contract.title}) at exact commit ${input.contract.implementationSha ?? 'UNKNOWN'}. Acceptance: ${input.contract.acceptance.join('; ')}`,
      resultInstructions('review', input.contract.taskId, input.contract.implementationSha),
    ].join('\n')
  }
  if (input.contract) {
    return [
      `Execute task ${input.contract.taskId}: ${input.contract.title}.`,
      `Allowed paths: ${input.contract.allowedPaths.join(', ')}.`,
      `Forbidden: ${input.contract.forbidden.join(', ')}.`,
      `Acceptance: ${input.contract.acceptance.join('; ')}.`,
      'Read .devloop/CONTRACT.json. Do not modify .devloop/.',
      resultInstructions('implementation', input.contract.taskId),
    ].join(' ')
  }
  return 'Follow the DevLoop task contract in this workspace.'
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
    let patchDir: string | null = null
    try {
      const argv = ['--profile', 'headless']
      if (input.route) {
        patchDir = await mkdtemp(join(tmpdir(), 'devloop-dsh-route-'))
        const patchPath = join(patchDir, 'route.patch.yml')
        await writeFile(patchPath, dshRoutePatch(input.route.model), 'utf8')
        argv.push('--patch', patchPath)
      }
      const prompt = headlessPrompt(input)
      argv.push(prompt)
      const request = {
        command: this.command,
        argv,
        cwd,
        timeoutMs,
        signal: input.signal,
      }
      // `dsh --profile headless` has no output options, so there is nothing to
      // read but the prose. Saying that here rather than only in the README is
      // what keeps its spend from silently looking like zero elsewhere.
      let reading = readPlainOutput((await this.runner(request)).stdout)
      let outcome
      if (reading.text.includes('<devloop_result>')) {
        try {
          outcome = parseDevloopResult(reading.text)
        } catch (error) {
          if (input.action.type === 'delegate') throw error
          const repairArgv = [
            ...argv.slice(0, -1),
            `${prompt}\n${protocolRepairInstruction()}`,
          ]
          reading = readPlainOutput((await this.runner({ ...request, argv: repairArgv })).stdout)
          outcome = reading.text.includes('<devloop_result>') ? parseDevloopResult(reading.text) : undefined
        }
      }
      return {
        status: 'started',
        ...(outcome === undefined ? {} : { outcome }),
        // Forwarded even though `readPlainOutput` never supplies them. Without
        // this line the counters are structurally absent, so a future reader
        // that does report them would be dropped here in silence — and the
        // test guarding dsh's silence could not tell the difference.
        ...(reading.tokens === undefined ? {} : { tokens: reading.tokens }),
        ...(reading.costUsd === undefined ? {} : { costUsd: reading.costUsd }),
        ...(input.route ? { agent: `${input.route.backend}/${input.route.model}` } : {}),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'dsh headless failed'
      return { status: 'failed', detail }
    } finally {
      if (patchDir) await rm(patchDir, { recursive: true, force: true }).catch(() => undefined)
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

function dshRoutePatch(model: string): string {
  return [
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    `    model: ${JSON.stringify(model)}`,
    '',
  ].join('\n')
}
