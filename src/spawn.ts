import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export const SIGKILL_GRACE_MS = 2_000
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
 * `cmd.exe /d /s /c` so `claude` / `codex` resolve. stdin is ignored. The child
 * is its own process group on Unix; abort waits for SIGKILL before settling.
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
    let settled = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
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
        finish(new Error(`spawn output exceeded maxBuffer (${stdout.length + stderr.length})`))
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
          if (closed && !settled) settleClose()
        }, SIGKILL_GRACE_MS)
      }
    }

    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      if (overflowed) return
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
      if (stdout.length + stderr.length > maxBuffer) {
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
  const line = winCmdCArgument(command, argv)
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
    ...options,
    detached: false,
    windowsVerbatimArguments: true,
    windowsHide: true,
  })
}

/**
 * Quote one argv token for `cmd.exe /s /c`. cmd does not treat `\` as a quote
 * escape; internal quotes are doubled. Always wrap so `&` `|` cannot inject.
 */
export function quoteForWinCmd(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`
}

/**
 * `/s /c` strips the first and last quote on the remainder. Wrap the already
 * token-quoted command so that strip leaves `"cmd" "arg"` intact.
 */
export function winCmdCArgument(command: string, argv: readonly string[]): string {
  const line = [command, ...argv].map(quoteForWinCmd).join(' ')
  return `"${line}"`
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnFireAndForget('taskkill', ['/pid', String(pid), '/T', '/F'])
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
