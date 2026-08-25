import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { emptyUsage } from './budget.js'
import type { LoopState } from './types.js'
import { STATE_VERSION } from './types.js'

export const DEVLOOP_DIR = '.devloop'
export const STATE_FILE = 'STATE.json'
export const GOAL_FILE = 'GOAL.md'

export function devloopDir(root: string): string {
  return join(root, DEVLOOP_DIR)
}

export function statePath(root: string): string {
  return join(devloopDir(root), STATE_FILE)
}

export function goalPath(root: string): string {
  return join(devloopDir(root), GOAL_FILE)
}

export async function workspaceArmed(root: string): Promise<boolean> {
  try {
    const info = await stat(devloopDir(root))
    return info.isDirectory()
  } catch {
    return false
  }
}

export function emptyState(now: number): LoopState {
  return {
    version: STATE_VERSION,
    goalCompleted: false,
    killSwitch: false,
    supervisor: null,
    tasks: [],
    usage: emptyUsage(now),
    lastAction: { type: 'idle' },
    updatedAt: new Date(now).toISOString(),
  }
}

export async function loadState(root: string, now: number): Promise<LoopState> {
  try {
    const raw = await readFile(statePath(root), 'utf8')
    const parsed = JSON.parse(raw) as LoopState
    if (parsed.version !== STATE_VERSION) {
      throw new Error(`unsupported STATE.json version ${String(parsed.version)}`)
    }
    return parsed
  } catch (error) {
    if (isNotFound(error)) return emptyState(now)
    throw error
  }
}

export async function saveState(root: string, state: LoopState): Promise<void> {
  const file = statePath(root)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT'
}
