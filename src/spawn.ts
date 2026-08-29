import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { join } from 'node:path'

export const SIGKILL_GRACE_MS = 2_000
/** SIGTERM grace + SIGKILL last-resort; service awaitDispatch must cover this. */
export const RUNNER_REAP_MS = SIGKILL_GRACE_MS * 2
export const MAX_SPAWN_BUFFER = 10 * 1024 * 1024

export interface HeadlessRun {
  readonly command: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /** Test override. Production callers omit this and use MAX_SPAWN_BUFFER. */
  readonly maxBuffer?: number
}

export type HeadlessRunner = (request: HeadlessRun) => Promise<{ stdout: string, stderr: string }>

/**
 * Spawn without a Unix shell. On Windows, npm `.cmd` shims are launched via
 * `cmd.exe /d /v:off /s /c` so `claude` / `codex` resolve. stdin is ignored. The child
 * is its own process group on Unix; abort waits for SIGKILL (and close) before settling.
 */
export function defaultRunner(request: HeadlessRun): Promise<{ stdout: string, stderr: string }> {
  if (request.signal?.aborted) {
    return Promise.reject(new Error('backend timeout'))
  }
  return new Promise((resolve, reject) => {
    const child = spawnCli(request.command, request.argv, {
      cwd: request.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let bufferedBytes = 0
    let settled = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let lastResortTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let overflowed = false
    let killing = false
    let closed = false
    let closeCode: number | null = null
    let closeSignal: NodeJS.Signals | null = null
    const maxBuffer = request.maxBuffer ?? MAX_SPAWN_BUFFER

    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer && !killing) clearTimeout(killTimer)
      if (lastResortTimer) clearTimeout(lastResortTimer)
      request.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }

    const settleClose = () => {
      if (request.signal?.aborted || timedOut) {
        finish(new Error('backend timeout'))
        return
      }
      if (overflowed) {
        finish(new Error(`spawn output exceeded maxBuffer (${bufferedBytes})`))
        return
      }
      if (closeCode === 0) {
        finish(null)
        return
      }
      if (closeSignal) {
        finish(new Error(`killed ${closeSignal}`))
        return
      }
      finish(new Error(closeCode == null ? 'spawn exited' : `exit ${closeCode}`))
    }

    const killTree = (signal: NodeJS.Signals) => {
      killProcessTree(child, signal)
    }

    const onAbort = () => {
      killing = true
      killTree('SIGTERM')
      if (!killTimer) {
        killTimer = setTimeout(() => {
          killTimer = undefined
          killTree('SIGKILL')
          if (closed && !settled) {
            settleClose()
            return
          }
          if (!settled && !lastResortTimer) {
            lastResortTimer = setTimeout(() => {
              lastResortTimer = undefined
              if (!settled) settleClose()
            }, SIGKILL_GRACE_MS)
          }
        }, SIGKILL_GRACE_MS)
      }
    }

    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      if (overflowed) return
      bufferedBytes += Buffer.byteLength(chunk, 'utf8')
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
      if (bufferedBytes > maxBuffer) {
        overflowed = true
        child.stdout?.destroy()
        child.stderr?.destroy()
        onAbort()
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => append('stdout', String(chunk)))
    child.stderr?.on('data', chunk => append('stderr', String(chunk)))

    if (request.signal?.aborted) onAbort()
    else request.signal?.addEventListener('abort', onAbort, { once: true })

    timeoutTimer = setTimeout(() => {
      timedOut = true
      onAbort()
    }, request.timeoutMs)

    child.on('error', error => finish(error instanceof Error ? error : new Error(String(error))))
    child.on('close', (code, signalName) => {
      closed = true
      closeCode = code
      closeSignal = signalName
      if (killing && killTimer) return
      settleClose()
    })
  })
}

function spawnCli(command: string, argv: readonly string[], options: SpawnOptions): ChildProcess {
  if (process.platform !== 'win32') {
    return spawn(command, [...argv], { ...options, detached: true })
  }
  return spawn(process.env.ComSpec || 'cmd.exe', winCmdSpawnArgs(command, argv), {
    ...options,
    detached: false,
    windowsVerbatimArguments: true,
    windowsHide: true,
  })
}

/**
 * Quote one argv token for `cmd /s /c` with `windowsVerbatimArguments`.
 * cmd.exe uses `""` for an embedded quote. `%` is caret-escaped so `cmd /c`
 * does not expand env vars and a native `.exe` still receives a single `%`.
 * CommandLineToArgvW treats `\` immediately before `"` as escaping it, so
 * those backslashes (and trailing backslashes before the closer) are doubled.
 */
export function quoteForWinCmd(value: string): string {
  const withPct = value.replace(/%/g, '^%')
  const withBs = withPct.replace(/(\\*)"/g, (_all, bs: string) => `${bs}${bs}"`)
  const trailed = withBs.replace(/(\\+)$/, m => m + m)
  return `"${trailed.replace(/"/g, '""')}"`
}

/**
 * `/s /c` strips the first and last quote on the remainder. Wrap the already
 * token-quoted command so that strip leaves `"cmd" "arg"` intact.
 */
export function winCmdCArgument(command: string, argv: readonly string[]): string {
  const line = [command, ...argv].map(quoteForWinCmd).join(' ')
  return `"${line}"`
}

/** `/d` skips AutoRun; `/v:off` disables delayed expansion (`!PATH!`). */
export function winCmdSpawnArgs(command: string, argv: readonly string[]): string[] {
  return ['/d', '/v:off', '/s', '/c', winCmdCArgument(command, argv)]
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnFireAndForget(winTaskkillPath(), ['/pid', String(pid), '/T', '/F'])
    try {
      child.kill('SIGKILL')
    } catch {
      // taskkill missing or child already gone
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/**
 * Windows tree-kill must not take down the host if `taskkill` is missing.
 * `spawn` ENOENT is async; try/catch does not catch it.
 */
export function spawnFireAndForget(command: string, argv: readonly string[]): void {
  spawn(command, [...argv], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
}

function winTaskkillPath(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
}
