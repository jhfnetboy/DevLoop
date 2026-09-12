import { constants, open } from 'node:fs/promises'
import { join } from 'node:path'
import { assertLocalDevloopDir, DEVLOOP_DIR } from './persist.js'
import type { PreprResult } from './prepr.js'

/**
 * One line per task check and per review verdict, in `.devloop/PR-LOG.jsonl`.
 *
 * The per-PR budget (≤200 lines, ≤5 files, ≤2 dirs) was adopted to be tried
 * and then judged on data; this is that data — how big each task's change was,
 * which rules it hit under which rules version, and what the reviewer said.
 * It records; nothing in the loop reads it back, so losing a line costs only
 * that line.
 */
export type PrLogEntry =
  | {
      readonly kind: 'check'
      readonly at: string
      readonly taskId: string
      readonly head: string | null
      readonly status: PreprResult['status']
      readonly size: PreprResult['size']
      readonly rules: readonly string[]
      readonly blocking: readonly string[]
      readonly checker: PreprResult['checker']
    }
  | {
      readonly kind: 'review'
      readonly at: string
      readonly taskId: string
      readonly head: string | null
      readonly verdict: string
      readonly reviewer: string | null
    }

export const PR_LOG_FILE = 'PR-LOG.jsonl'
const TAIL_BYTES = 256 * 1024

export function checkEntry(taskId: string, head: string | null, result: PreprResult, now: number): PrLogEntry {
  return {
    kind: 'check',
    at: new Date(now).toISOString(),
    taskId,
    head,
    status: result.status,
    size: result.size,
    rules: [...new Set(result.findings.map(f => f.rule))],
    blocking: [...new Set(result.findings.filter(f => f.severity === 'block').map(f => f.rule))],
    checker: result.checker,
  }
}

/** Append one entry. Best-effort: a failure is logged, never raised into the loop. */
export async function appendPrLog(root: string, entry: PrLogEntry, log: { error(message: string, ...rest: unknown[]): void }): Promise<void> {
  let handle
  try {
    await assertLocalDevloopDir(root)
    handle = await open(join(root, DEVLOOP_DIR, PR_LOG_FILE), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    log.error('[dsh-devloop] PR log append failed', error)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** The last `limit` entries, newest last; torn or foreign lines are skipped. */
export async function readPrLog(root: string, limit = 100): Promise<PrLogEntry[]> {
  let handle
  try {
    await assertLocalDevloopDir(root) // as on append: a symlinked .devloop is not followed
    handle = await open(join(root, DEVLOOP_DIR, PR_LOG_FILE), constants.O_RDONLY | constants.O_NOFOLLOW)
    const { size } = await handle.stat()
    // One byte before the window too: then the first piece is either empty (the
    // window began exactly on a line) or a real fragment, and dropping it is right
    // either way. Without it, a window that began on a line boundary lost that line.
    const start = Math.max(0, size - TAIL_BYTES - 1)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    const entries: PrLogEntry[] = []
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as { kind?: unknown, taskId?: unknown }
        if ((value.kind === 'check' || value.kind === 'review') && typeof value.taskId === 'string') entries.push(value as PrLogEntry)
      } catch {
        // torn final append, or not ours
      }
    }
    return entries.slice(-limit)
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
