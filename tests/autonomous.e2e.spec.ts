import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentBackend, AgentRunInput, AgentRunResult } from '../src/backend.ts'
import { resolveConfig } from '../src/config.ts'
import { loadState, saveState } from '../src/persist.ts'
import DevloopService from '../src/service.ts'
import { initGitRepo, mkdtempInRepo } from './helpers.ts'

class ScriptedFactoryBackend implements AgentBackend {
  readonly actions: string[] = []

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.actions.push(input.action.type)
    if (input.action.type === 'plan') {
      return {
        status: 'started',
        agent: 'codex/planner',
        outcome: {
          version: 1,
          kind: 'plan',
          tasks: [{
            id: 'E2E-1',
            title: 'Add generated module',
            tier: 'T1',
            risk: 'low',
            allowedPaths: ['src/**'],
            acceptance: ['src/generated.ts exports answer'],
          }],
        },
      }
    }
    if (input.action.type === 'delegate') {
      if (!input.worktreeRoot) throw new Error('missing delegate worktree')
      await mkdir(join(input.worktreeRoot, 'src'), { recursive: true })
      await writeFile(join(input.worktreeRoot, 'src', 'generated.ts'), 'export const answer = 42\n', 'utf8')
      return {
        status: 'started',
        agent: 'dsh/flash',
        outcome: {
          version: 1,
          kind: 'implementation',
          taskId: input.action.taskId,
          outcome: 'completed',
          summary: 'added module',
        },
      }
    }
    if (!input.contract?.implementationSha) throw new Error('review is not SHA-bound')
    return {
      status: 'started',
      agent: 'claude/opus',
      outcome: {
        version: 1,
        kind: 'review',
        taskId: input.action.taskId,
        reviewedSha: input.contract.implementationSha,
        verdict: 'PASS',
        notes: 'acceptance satisfied',
      },
    }
  }

  async cancel(): Promise<void> {}
  async health(): Promise<'ok'> { return 'ok' }
}

describe('autonomous 0.3 composition', () => {
  it('runs plan → implement → review → merge → goal complete without operator state edits', async () => {
    const root = await mkdtempInRepo('devloop-auto-e2e-')
    await initGitRepo(root)
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n\nAdd generated module.\n', 'utf8')
    const backend = new ScriptedFactoryBackend()
    const service = new DevloopService(new Context(), resolveConfig({
      root,
      enabled: false,
      tickIntervalMs: 60_000,
    }), backend)

    await service.tick() // plan result creates ready task
    expect((await loadState(root, Date.now())).tasks[0]?.status).toBe('ready')
    await service.tick() // delegate result is checked and host-committed
    const implemented = await loadState(root, Date.now())
    expect(implemented.tasks[0]).toMatchObject({ status: 'review_pending', implementer: 'dsh/flash' })
    expect(implemented.tasks[0]?.implementationSha).toMatch(/^[0-9a-f]{40}$/)
    await service.tick() // independent, exact-SHA review
    expect((await loadState(root, Date.now())).tasks[0]?.status).toBe('merge_ready')
    await service.tick() // mechanical merge
    expect((await loadState(root, Date.now())).tasks[0]?.status).toBe('done')
    await service.tick() // deterministic terminal decision
    const completed = await loadState(root, Date.now())
    expect(completed.lastAction).toEqual({ type: 'stop', reason: 'goal_complete' })
    expect(completed.killSwitch).toBe(true)
    expect(completed.goalCompleted).toBe(true)
    await expect(readFile(join(root, 'src', 'generated.ts'), 'utf8'))
      .resolves.toBe('export const answer = 42\n')
    expect(backend.actions).toEqual(['plan', 'delegate', 'review'])
    const journal = await readFile(join(root, '.devloop', 'EVENTS.jsonl'), 'utf8')
    expect(journal.trim().split('\n').length).toBeGreaterThanOrEqual(8)

    // Keep the fixture's final snapshot explicitly loadable after a restart.
    await saveState(root, completed, { expectedRevision: completed.revision, action: 'e2e-checkpoint' })
    expect((await loadState(root, Date.now())).revision).toBe(completed.revision + 1)
  }, 30_000)
})
