import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What a model's own process must not inherit from this host: the ways to act
 * on the forge or a remote as the operator. A worker that could run `gh pr
 * merge` or `git push` with the host's login could merge its own work past
 * every review this loop enforces.
 *
 * Whole families go, not a list of names: git reads config from numbered
 * `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs that a model can switch back on
 * by setting `GIT_CONFIG_COUNT` itself, so the pairs must not be there at all.
 */
const WORKER_UNSET_PREFIXES = ['GIT_', 'GH_', 'GITHUB_', 'SSH_']

/** The inherited names a model process starts without, read from the environment as it is now. Case-insensitive, as Windows names are. */
export function workerUnset(source: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(source).filter(name => WORKER_UNSET_PREFIXES.some(prefix => name.toUpperCase().startsWith(prefix)))
}

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
    unsetEnv: workerUnset(),
    env: {
      GH_CONFIG_DIR: join(empty, 'gh'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    },
  }
}
