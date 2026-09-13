import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What a model's own process must not inherit from this host: the ways to act
 * on the forge or a remote as the operator. A worker that could run `gh pr
 * merge` or `git push` with the host's login would merge its own work past
 * every review this loop enforces.
 */
export const WORKER_UNSET: readonly string[] = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO', 'GH_CONFIG_DIR',
  'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
]

let empty: string | null = null

/**
 * The environment every model CLI runs with. `gh` gets a config directory with
 * no login in it; git reads no global or system config, so no credential
 * helper (the macOS keychain included) answers for it; nothing prompts.
 *
 * This removes what the process is handed. A model that can read files outside
 * its worktree can still find credentials on disk: that is its sandbox's to
 * stop, not this environment's.
 */
export function workerEnv(): { readonly env: Readonly<Record<string, string>>, readonly unsetEnv: readonly string[] } {
  empty ??= mkdtempSync(join(tmpdir(), 'devloop-worker-'))
  return {
    unsetEnv: WORKER_UNSET,
    env: {
      GH_CONFIG_DIR: join(empty, 'gh'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    },
  }
}
