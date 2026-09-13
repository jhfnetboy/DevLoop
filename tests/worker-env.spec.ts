import { afterEach, describe, expect, it } from 'vitest'
import { readdir } from 'node:fs/promises'
import { runInputFor } from '../src/backend.ts'
import { ClaudeCliBackend, CodexCliBackend } from '../src/cli.ts'
import { resolveConfig } from '../src/config.ts'
import { DshHeadlessBackend, type HeadlessRun } from '../src/dsh.ts'
import { defaultRunner } from '../src/spawn.ts'
import { WORKER_UNSET, workerEnv } from '../src/worker-env.ts'
import { baseState, makeTask } from './helpers.ts'

const saved = { GH_TOKEN: process.env.GH_TOKEN, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('the environment a model runs in', () => {
  it('carries none of the host\'s ways to act on the forge or a remote', async () => {
    process.env.GH_TOKEN = 'host-token-must-not-leak'
    process.env.SSH_AUTH_SOCK = '/tmp/host-agent.sock'
    const { stdout } = await defaultRunner({
      command: 'sh',
      argv: ['-c', 'printf "%s|%s|%s|%s" "${GH_TOKEN-unset}" "${SSH_AUTH_SOCK-unset}" "$GH_CONFIG_DIR" "$(git config --global --list 2>/dev/null | wc -l | tr -d " ")"'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      ...workerEnv(),
    })
    const [token, agent, ghConfig, globalEntries] = stdout.split('|')
    expect(token).toBe('unset')
    expect(agent).toBe('unset')
    // gh looks for its login in a directory that has none.
    expect(ghConfig).toMatch(/devloop-worker-.*[/\\]gh$/)
    await expect(readdir(ghConfig!)).rejects.toThrow()
    // No global git config: no credential helper, the keychain's included.
    expect(globalEntries).toBe('0')
    expect(WORKER_UNSET).toEqual(expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS']))
  })

  it('is what every model CLI is started with, whatever its role', async () => {
    const task = makeTask({ id: 'd1', status: 'review_pending', implementationSha: 'a'.repeat(40) })
    const input = (type: 'delegate' | 'review') => ({
      ...runInputFor('/repo', { type, taskId: 'd1' }, baseState({ tasks: [task] }), resolveConfig({}).budget),
      worktreeRoot: '/repo/.devloop/worktrees/d1',
    })
    const seen: HeadlessRun[] = []
    const runner = async (request: HeadlessRun) => { seen.push(request); return { stdout: 'done', stderr: '' } }
    for (const backend of [new DshHeadlessBackend(runner), new ClaudeCliBackend(runner), new CodexCliBackend(runner)]) {
      await backend.run(input('delegate')).catch(() => undefined)
      await backend.run(input('review')).catch(() => undefined)
    }
    expect(seen.length).toBeGreaterThanOrEqual(6)
    for (const request of seen) {
      expect(request.unsetEnv, request.command).toEqual(WORKER_UNSET)
      expect(request.env?.GIT_CONFIG_GLOBAL, request.command).toBe('/dev/null')
      expect(request.env?.GH_CONFIG_DIR, request.command).toMatch(/devloop-worker-/)
    }
    // dsh keeps its write fence whatever mode the daemon was started with.
    for (const request of seen.filter(r => r.command === 'dsh')) {
      expect(seen.some(r => r.command === 'dsh')).toBe(true)
      expect(request.env?.DSH_PERMISSION_MODE).toBe('workspace-write')
    }
  })
})
