import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDashboardHandler,
  dashboardAssetsDir,
  loadDashboardAssets,
  type DashboardDeps,
} from '../src/dashboard.ts'
import { saveState } from '../src/persist.ts'
import { listProjects, projectId, registryPath } from '../src/projects.ts'
import { baseState, makeTask, mkdtempInRepo, withTasks } from './helpers.ts'

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

const ASSETS = { html: '<!doctype html><title>page</title>', js: 'void 0', css: 'body{}' }

function deps(overrides: Partial<DashboardDeps> & Pick<DashboardDeps, 'ownRoot' | 'home'>): DashboardDeps {
  return {
    loopRunning: () => true,
    requestRejection: () => undefined,
    assets: ASSETS,
    ...overrides,
  }
}

async function call(
  handler: ReturnType<typeof createDashboardHandler>,
  method: string,
  url: string,
): Promise<Captured> {
  const out: Captured = { status: 0, headers: {}, body: '' }
  const res = {
    setHeader(name: string, value: string) { out.headers[name.toLowerCase()] = value },
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status
      for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = v
    },
    end(body?: string) { out.body = body ?? '' },
  }
  const req = { method, url, headers: { host: '127.0.0.1:3080' } }
  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  return out
}

async function armedProject(prefix: string): Promise<string> {
  const root = await mkdtempInRepo(prefix)
  await mkdir(join(root, '.devloop'))
  await writeFile(join(root, '.devloop', 'GOAL.md'), '# Ship the thing\n', 'utf8')
  return root
}

describe('dashboard access', () => {
  it('serves nothing — not even its script — to a request DSH would not authenticate', async () => {
    const root = await armedProject('dash-auth-')
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root, requestRejection: () => 401 }))
    for (const path of ['/devloop/', '/devloop/app.js', '/devloop/api/projects']) {
      const res = await call(handler, 'GET', path)
      expect(res.status).toBe(401)
      expect(res.body).not.toContain(root)
      expect(res.body).not.toBe(ASSETS.js)
    }
  })

  it('refuses a host or origin DSH refuses', async () => {
    const root = await armedProject('dash-403-')
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root, requestRejection: () => 403 }))
    const res = await call(handler, 'GET', '/devloop/api/projects')
    expect(res.status).toBe(403)
    expect(res.body).toBe('forbidden\n')
  })

  it('is read-only: anything but GET and HEAD is refused before it is routed', async () => {
    const root = await armedProject('dash-405-')
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root }))
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await call(handler, method, '/devloop/api/projects')
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('GET, HEAD')
    }
  })

  it('ships a CSP with no inline script on the page and on data', async () => {
    const root = await armedProject('dash-csp-')
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root }))
    for (const path of ['/devloop/', '/devloop/api/projects']) {
      const res = await call(handler, 'GET', path)
      expect(res.status).toBe(200)
      expect(res.headers['content-security-policy']).toContain("script-src 'self'")
      expect(res.headers['content-security-policy']).not.toContain('unsafe-inline')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['cache-control']).toBe('no-store')
    }
  })

  it('redirects the bare path and answers HEAD without a body', async () => {
    const root = await armedProject('dash-head-')
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root }))
    const bare = await call(handler, 'GET', '/devloop')
    expect(bare.status).toBe(308)
    expect(bare.headers.location).toBe('/devloop/')
    const head = await call(handler, 'HEAD', '/devloop/')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0)
  })
})

describe('dashboard projects', () => {
  it('lists the process root and the registry, and names projects by id rather than path', async () => {
    const own = await armedProject('dash-own-')
    const other = await armedProject('dash-other-')
    const home = await mkdtempInRepo('dash-home-')
    await mkdir(join(home, 'devloop'))
    await writeFile(registryPath(home), JSON.stringify({ projects: [{ root: other }, { root: own }] }), 'utf8')

    const handler = createDashboardHandler(deps({ ownRoot: own, home }))
    const res = await call(handler, 'GET', '/devloop/api/projects')
    const body = JSON.parse(res.body) as { value: { projects: Array<{ id: string, root: string, own: boolean, loop: string }> } }
    const projects = body.value.projects
    // Listed once each, even though the registry repeats the process's own root.
    expect(projects.map(p => p.own)).toEqual([true, false])
    expect(projects[0]?.loop).toBe('running')
    expect(projects[1]?.loop).toBe('elsewhere')
    for (const project of projects) expect(project.id).toMatch(/^[0-9a-f]{12}$/)
  })

  it('cannot be pointed at a directory nobody registered', async () => {
    const own = await armedProject('dash-trav-')
    const handler = createDashboardHandler(deps({ ownRoot: own, home: own }))
    for (const path of [
      '/devloop/api/projects/..%2F..%2Fetc',
      `/devloop/api/projects/${encodeURIComponent('/etc')}`,
      `/devloop/api/projects/${projectId('/etc')}`,
    ]) {
      const res = await call(handler, 'GET', path)
      expect(res.status).toBe(404)
    }
  })

  it('reports a registry it had to partly ignore instead of failing the page', async () => {
    const own = await armedProject('dash-reg-')
    const home = await mkdtempInRepo('dash-reghome-')
    await mkdir(join(home, 'devloop'))
    await writeFile(registryPath(home), JSON.stringify({ projects: [{ root: 'relative/path' }, { nope: 1 }] }), 'utf8')
    const list = await listProjects(own, home)
    expect(list.projects).toHaveLength(1)
    expect(list.registryError).toMatch(/entries 0, 1 ignored/)

    await writeFile(registryPath(home), '{ not json', 'utf8')
    const broken = await listProjects(own, home)
    expect(broken.projects).toHaveLength(1)
    expect(broken.registryError).toMatch(/not valid JSON/)
  })

  it('shows tasks, the pending question, and event envelopes without their state snapshots', async () => {
    const root = await armedProject('dash-detail-')
    const state = withTasks(baseState(), [
      makeTask({ id: 't1', status: 'done', title: 'first' }),
      makeTask({ id: 't2', status: 'review_pending', title: 'second' }),
    ])
    const first = await saveState(root, state, { action: 'plan' })
    await saveState(root, {
      ...first,
      killSwitch: true,
      supervisor: { taskId: 't2', reason: 'empty_task' },
      lastAction: { type: 'stop', reason: 'blocked' },
    }, { expectedRevision: first.revision, action: 'hold:empty_task' })

    const handler = createDashboardHandler(deps({ ownRoot: root, home: root, loopRunning: () => false }))
    const res = await call(handler, 'GET', `/devloop/api/projects/${projectId(root)}`)
    expect(res.status).toBe(200)
    const detail = (JSON.parse(res.body) as { value: Record<string, unknown> }).value as {
      loop: string, armed: boolean, halted: boolean, question: string | null,
      tasks: Array<{ id: string, status: string }>, taskCounts: Record<string, number>,
      gate: { options: Array<{ key: string }> } | null, goal: string,
      events: Array<Record<string, unknown>>,
    }
    expect(detail.loop).toBe('stopped')
    expect(detail.armed).toBe(true)
    expect(detail.halted).toBe(true)
    expect(detail.goal).toBe('# Ship the thing\n')
    expect(detail.tasks.map(t => t.id)).toEqual(['t1', 't2'])
    expect(detail.taskCounts).toEqual({ done: 1, review_pending: 1 })
    expect(detail.question).toBeTruthy()
    expect(detail.gate?.options.map(o => o.key)).toContain('stop')
    // Newest first, and only the envelope.
    expect(detail.events.map(e => e.action)).toEqual(['hold:empty_task', 'plan'])
    for (const event of detail.events) expect(Object.keys(event).sort()).toEqual(['action', 'at', 'revision'])
  })

  it('does not read a GOAL.md or PROGRESS.md that is a symlink to somewhere else', async () => {
    const secret = join(await mkdtempInRepo('dash-secret-'), 'secret.txt')
    await writeFile(secret, 'do not serve me', 'utf8')

    const linkedGoal = await mkdtempInRepo('dash-lgoal-')
    await mkdir(join(linkedGoal, '.devloop'))
    await symlink(secret, join(linkedGoal, '.devloop', 'GOAL.md'))
    const goalHandler = createDashboardHandler(deps({ ownRoot: linkedGoal, home: linkedGoal }))
    const goalRes = await call(goalHandler, 'GET', `/devloop/api/projects/${projectId(linkedGoal)}`)
    expect(goalRes.body).not.toContain('do not serve me')
    expect((JSON.parse(goalRes.body) as { value: { armed: boolean } }).value.armed).toBe(false)

    const linkedProgress = await armedProject('dash-lprog-')
    await symlink(secret, join(linkedProgress, '.devloop', 'PROGRESS.md'))
    const progHandler = createDashboardHandler(deps({ ownRoot: linkedProgress, home: linkedProgress }))
    const progRes = await call(progHandler, 'GET', `/devloop/api/projects/${projectId(linkedProgress)}`)
    expect(progRes.body).not.toContain('do not serve me')
    expect((JSON.parse(progRes.body) as { value: { progress: string | null } }).value.progress).toBeNull()
  })

  it('shows an unarmed project as unarmed and a vanished one as missing', async () => {
    const bare = await mkdtempInRepo('dash-bare-')
    const home = await mkdtempInRepo('dash-mhome-')
    await mkdir(join(home, 'devloop'))
    await writeFile(registryPath(home), JSON.stringify({ projects: [{ root: join(bare, 'gone') }] }), 'utf8')
    const handler = createDashboardHandler(deps({ ownRoot: bare, home }))
    const res = await call(handler, 'GET', '/devloop/api/projects')
    const projects = (JSON.parse(res.body) as { value: { projects: Array<{ armed: boolean, error: string | null }> } }).value.projects
    expect(projects[0]).toMatchObject({ armed: false, error: null })
    expect(projects[1]).toMatchObject({ armed: false, error: 'directory not found' })
  })
})

describe('dashboard assets', () => {
  it('ships the page the package lists, and the script never parses data as markup', async () => {
    const assets = await loadDashboardAssets(dashboardAssetsDir())
    expect(assets.html).toContain('/devloop/app.js')
    expect(assets.css.length).toBeGreaterThan(0)
    // Task titles and gate evidence are model output. The page may only place
    // them as text; a single innerHTML/outerHTML/insertAdjacentHTML is how that
    // stops being true.
    expect(assets.js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
    // And nothing inline that the CSP would have to allow.
    expect(assets.html).not.toMatch(/<script>(?!<)|\sstyle=|\son[a-z]+=/)
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { files: string[] }
    expect(pkg.files).toContain('dashboard')
  })
})
