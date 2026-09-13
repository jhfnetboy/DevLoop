import { afterEach, describe, expect, it } from 'vitest'
import { readdir } from 'node:fs/promises'
import { runInputFor } from '../src/backend.ts'
import { ClaudeCliBackend, CodexCliBackend } from '../src/cli.ts'
import { resolveConfig } from '../src/config.ts'
import { DshHeadlessBackend, type HeadlessRun } from '../src/dsh.ts'
import { defaultRunner } from '../src/spawn.ts'
import { workerEnv, workerUnset } from '../src/worker-env.ts'
import { baseState, makeTask } from './helpers.ts'

const HOST = ['GH_TOKEN', 'SSH_AUTH_SOCK', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']
const saved = Object.fromEntries(HOST.map(name => [name, process.env[name]]))
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
    // How an operator hands git a credential through the environment.
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    process.env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic host-sentinel'
    const { stdout } = await defaultRunner({
      command: 'sh',
      // The model turns the numbered config back on itself before asking git for it.
      argv: ['-c', 'printf "%s|%s|%s|%s|%s" "${GH_TOKEN-unset}" "${SSH_AUTH_SOCK-unset}" "$GH_CONFIG_DIR" "$(git config --global --list 2>/dev/null | wc -l | tr -d " ")" "$(GIT_CONFIG_COUNT=1 git config --get-regexp extraheader 2>&1)"'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      ...workerEnv(),
    })
    const [token, agent, ghConfig, globalEntries, reopened] = stdout.split('|')
    expect(token).toBe('unset')
    expect(agent).toBe('unset')
    // gh looks for its login in a directory that has none.
    expect(ghConfig).toMatch(/devloop-worker-.*[/\\]gh$/)
    await expect(readdir(ghConfig!)).rejects.toThrow()
    // No global git config: no credential helper, the keychain's included.
    expect(globalEntries).toBe('0')
    expect(reopened).not.toContain('host-sentinel')
    expect(stdout).not.toContain('host-sentinel')
    expect(workerUnset({ GIT_CONFIG_KEY_7: '', gh_token: '', GITHUB_ENTERPRISE_TOKEN: '', SSH_ASKPASS: '', PATH: '', HOME: '', DEEPSEEK_API_KEY: '' }))
      .toEqual(['GIT_CONFIG_KEY_7', 'gh_token', 'GITHUB_ENTERPRISE_TOKEN', 'SSH_ASKPASS'])
  })

  it('is what every model CLI is started with, whatever its role', async () => {
    const task = makeTask({ id: 'd1', status: 'review_pending', implementationSha: 'a'.repeat(40) })
    const input = (type: 'delegate' | 'review') => ({
      ...runInputFor('/repo', { type, taskId: 'd1' }, baseState({ tasks: [task] }), resolveConfig({}).budget),
      worktreeRoot: '/repo/.devloop/worktrees/d1',
    })
    process.env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    const seen: HeadlessRun[] = []
    const runner = async (request: HeadlessRun) => { seen.push(request); return { stdout: 'done', stderr: '' } }
    for (const backend of [new DshHeadlessBackend(runner), new ClaudeCliBackend(runner), new CodexCliBackend(runner)]) {
      await backend.run(input('delegate')).catch(() => undefined)
      await backend.run(input('review')).catch(() => undefined)
    }
    expect(seen.length).toBeGreaterThanOrEqual(6)
    for (const request of seen) {
      expect(request.unsetEnv, request.command).toEqual(workerUnset())
      expect(request.unsetEnv, request.command).toContain('GIT_CONFIG_KEY_0')
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
