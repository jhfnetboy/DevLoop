import { spawn, type ChildProcess } from 'node:child_process'

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
 * Spawn without a shell. stdin is ignored so CLIs that drain stdin (codex exec)
 * return instead of hanging until timeout. The child is its own process group
 * so abort/timeout can SIGTERM then SIGKILL the whole tree. The promise settles
 * only after the child is reaped.
 */
export function defaultRunner(request: HeadlessRun): Promise<{ stdout: string, stderr: string }> {
  if (request.signal?.aborted) {
    return Promise.reject(new Error('backend timeout'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.argv], {
      cwd: request.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let overflowed = false
    const maxBuffer = request.maxBuffer ?? MAX_SPAWN_BUFFER

    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      request.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }

    const killTree = (signal: NodeJS.Signals) => {
      killProcessTree(child, signal)
    }

    const onAbort = () => {
      killTree('SIGTERM')
      if (!killTimer) {
        killTimer = setTimeout(() => killTree('SIGKILL'), SIGKILL_GRACE_MS)
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
      if (request.signal?.aborted || timedOut) {
        finish(new Error('backend timeout'))
        return
      }
      if (overflowed) {
        finish(new Error(`spawn output exceeded maxBuffer (${stdout.length + stderr.length})`))
        return
      }
      if (code === 0) {
        finish(null)
        return
      }
      if (signalName) {
        finish(new Error(`killed ${signalName}`))
        return
      }
      finish(new Error(code == null ? 'spawn exited' : `exit ${code}`))
    })
  })
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      child.kill(signal)
    } catch {
      // already gone
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
