import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createDashboardHandler } from '../src/dashboard.ts'
import { emptyState, saveState, withStateLock } from '../src/persist.ts'
import { projectId, registryPath } from '../src/projects.ts'
import { initWorkRepo, makeTask, mkdtempInRepo } from './helpers.ts'

const git = (root: string, ...args: string[]) => promisify(execFile)('git', ['-C', root, ...args])

async function setup(prefix: string) {
  const root = await realpath(await mkdtempInRepo(prefix))
  await initWorkRepo(root)
  const home = await mkdtemp(join(tmpdir(), 'status-home-'))
  await mkdir(join(home, 'devloop'))
  await writeFile(registryPath(home), JSON.stringify({ projects: [{ root }] }), 'utf8')
  const logged: unknown[] = []
  const handler = createDashboardHandler({
    ownRoot: home, home, presence: () => 'running', requestRejection: () => undefined, assets: { html: '', js: '', css: '' },
    logError: (_message, error) => { logged.push(error) },
  })
  const call = async (method: string, path: string, body?: unknown, type = 'application/json') => {
    const out = { status: 0, body: '' }
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = { method, url: `/devloop/api/projects/${projectId(root)}${path}`, headers: { 'content-type': type }, async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(payload) } }
    const res = { setHeader() {}, writeHead(s: number) { out.status = s }, end(t?: string) { out.body = t ?? '' } }
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    let parsed: { value?: any, error?: { code: string } } = {}
    try { parsed = JSON.parse(out.body || '{}') } catch { /* plain-text answers, like 405 */ }
    return { status: out.status, body: out.body, json: parsed }
  }
  return { root, call, logged }
}

describe('status and cleanup routes', () => {
  it('shows the plan with active task branches kept, and deletes only what is confirmed and offered', async () => {
    const { root, call } = await setup('route-status-')
    await git(root, 'branch', 'merged-a')
    await git(root, 'branch', 'devloop/T1')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# g\n', 'utf8')
    await saveState(root, { ...emptyState(Date.now()), tasks: [makeTask({ id: 'T1', status: 'ready' })] })

    const view = await call('GET', '/status')
    expect(view.status).toBe(200)
    expect(view.json.value.plan.delete).toEqual(['merged-a'])
    expect(view.json.value.plan.keep).toContainEqual({ name: 'devloop/T1', reason: '循环里还没完成的任务' })

    const done = await call('POST', '/cleanup', { branches: ['merged-a', 'devloop/T1'] })
    expect(done.status).toBe(200)
    expect(done.json.value.deleted).toEqual(['merged-a'])
    expect(done.json.value.refused.map((r: { name: string }) => r.name)).toEqual(['devloop/T1'])
  })

  it('refuses a bad body, answers busy while the loop holds the lock, and touches nothing', async () => {
    const { root, call } = await setup('route-cleanup-')
    await git(root, 'branch', 'merged-b')
    expect((await call('POST', '/cleanup', { branches: [] })).status).toBe(400)
    expect((await call('POST', '/cleanup', { branches: ['-D'] })).status).toBe(400)
    expect((await call('POST', '/cleanup', { branches: ['merged-b'] }, 'text/plain')).status).toBe(415)
    expect((await call('GET', '/cleanup')).status).toBe(405)

    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# g\n', 'utf8')
    await saveState(root, emptyState(Date.now()))
    let busy = 0
    await withStateLock(root, async () => { busy = (await call('POST', '/cleanup', { branches: ['merged-b'] })).status })
    expect(busy).toBe(503)
    expect((await git(root, 'rev-parse', '--verify', 'refs/heads/merged-b')).stdout).toBeTruthy()
  })

  it('says a vanished repository cannot be read, without git\'s message or its path', async () => {
    const { root, call, logged } = await setup('route-gone-')
    await promisify(execFile)('rm', ['-rf', join(root, '.git')])
    const res = await call('GET', '/status')
    expect(res.status).toBe(422)
    expect(res.body).not.toContain(root)
    expect(logged).toHaveLength(1) // the full error goes to the log, not the page
    expect((await call('GET', '/other')).status).toBe(404)
    expect((await call('GET', '/status/x')).status).toBe(404)
  })

  it('refuses to scan or clean up when STATE cannot be read, instead of offering task branches', async () => {
    const { root, call } = await setup('route-badstate-')
    await git(root, 'branch', 'devloop/T1')
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# g\n', 'utf8')
    await writeFile(join(root, '.devloop', 'STATE.json'), '{ not json', 'utf8') // no journal to recover from
    const view = await call('GET', '/status')
    expect(view.status).toBe(422)
    expect(view.body).toMatch(/STATE cannot be read/)
    expect((await call('POST', '/cleanup', { branches: ['devloop/T1'] })).status).toBe(422)
    expect((await git(root, 'rev-parse', '--verify', 'refs/heads/devloop/T1')).stdout).toBeTruthy()
  })

  it('holds the state lock only to read the live task branches, not through the deletes', async () => {
    const { root, call } = await setup('route-window-')
    const names = Array.from({ length: 150 }, (_, i) => `merged-${i}`)
    for (const name of names) await git(root, 'branch', name)
    await mkdir(join(root, '.devloop'))
    await writeFile(join(root, '.devloop', 'GOAL.md'), '# g\n', 'utf8')
    await saveState(root, emptyState(Date.now()))
    const cleaning = call('POST', '/cleanup', { branches: names })
    await new Promise(resolve => setTimeout(resolve, 150)) // well inside 150 sequential deletes
    const loop = await withStateLock(root, async () => 'got it')
    expect(loop).toEqual({ ok: true, value: 'got it' }) // a loop saving a result is not refused
    expect((await cleaning).json.value.deleted).toHaveLength(150)
  })
})
