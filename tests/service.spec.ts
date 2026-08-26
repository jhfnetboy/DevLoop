import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../src/config.ts'
import { loadState, workspaceArmed } from '../src/persist.ts'
import DevloopService from '../src/service.ts'

async function waitForAction(root: string, type: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const state = await loadState(root, Date.now())
    if (state.lastAction.type === type) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const last = await loadState(root, Date.now())
  throw new Error(`timed out waiting for action ${type}, last=${last.lastAction.type}`)
}

describe('DevloopService', () => {
  const services: DevloopService[] = []

  afterEach(() => {
    for (const service of services) service.stop()
    services.length = 0
  })

  it('stays idle when the workspace is not armed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-svc-'))
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }))
    services.push(service)
    await service.tick()
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'idle' })
    expect(loaded.killSwitch).toBe(false)
  })

  it('records plan then stops rewriting after the first armed tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-svc-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, tickIntervalMs: 60_000 }))
    services.push(service)
    await waitForAction(root, 'plan')
    const first = await loadState(root, Date.now())
    expect(first.lastAction).toEqual({ type: 'plan' })
    const updatedAt = first.updatedAt
    await service.tick()
    const second = await loadState(root, Date.now())
    expect(second.lastAction).toEqual({ type: 'plan' })
    expect(second.updatedAt).toBe(updatedAt)
  })

  it('does not start when disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devloop-svc-'))
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# Goal\n', 'utf8')
    expect(await workspaceArmed(root)).toBe(true)
    const ctx = new Context()
    const service = new DevloopService(ctx, resolveConfig({ root, enabled: false }))
    services.push(service)
    await new Promise(resolve => setTimeout(resolve, 50))
    const loaded = await loadState(root, Date.now())
    expect(loaded.lastAction).toEqual({ type: 'idle' })
  })
})
