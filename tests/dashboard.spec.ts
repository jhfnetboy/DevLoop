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
import { loadState, saveState } from '../src/persist.ts'
import { listProjects, projectId, registryPath } from '../src/projects.ts'
import { baseState, initGitRepo, makeTask, mkdtempInRepo, withTasks } from './helpers.ts'

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

const ASSETS = { html: '<!doctype html><title>page</title>', js: 'void 0', css: 'body{}' }

function deps(overrides: Partial<DashboardDeps> & Pick<DashboardDeps, 'ownRoot' | 'home'>): DashboardDeps {
  return {
    presence: (_root, own) => own ? 'running' : 'elsewhere',
    requestRejection: () => undefined,
    assets: ASSETS,
    ...overrides,
  }
}

async function call(
  handler: ReturnType<typeof createDashboardHandler>,
  method: string,
  url: string,
  body?: unknown,
  contentType = 'application/json',
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
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...(body === undefined ? {} : { 'content-type': contentType }) },
    async *[Symbol.asyncIterator]() { if (payload !== '') yield Buffer.from(payload) },
  }
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

  it('reads with GET and writes with POST, and nothing else reaches a handler', async () => {
    const root = await armedProject('dash-405-')
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root }))
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await call(handler, method, '/devloop/api/projects')
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('GET, HEAD, POST')
    }
    for (const method of ['POST', 'PUT']) {
      const res = await call(handler, method, `/devloop/api/projects/${projectId(root)}`)
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('GET, HEAD')
    }
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await call(handler, method, `/devloop/api/projects/${projectId(root)}/pause`)
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('POST')
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

    const handler = createDashboardHandler(deps({ ownRoot: root, home: root, presence: () => 'stopped' }))
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

  it('shows an unarmed repository as unarmed and a vanished one as missing', async () => {
    const repo = await mkdtempInRepo('dash-bare-')
    await initGitRepo(repo)
    const home = await mkdtempInRepo('dash-mhome-')
    await mkdir(join(home, 'devloop'))
    await writeFile(registryPath(home), JSON.stringify({ projects: [{ root: join(repo, 'gone') }] }), 'utf8')
    const handler = createDashboardHandler(deps({ ownRoot: repo, home }))
    const res = await call(handler, 'GET', '/devloop/api/projects')
    const projects = (JSON.parse(res.body) as { value: { projects: Array<{ armed: boolean, own: boolean, error: string | null }> } }).value.projects
    expect(projects[0]).toMatchObject({ own: true, armed: false, error: null })
    expect(projects[1]).toMatchObject({ own: false, armed: false, error: 'directory not found' })
  })

  it('leaves out an own root that could never be a project', async () => {
    // What launchd gives DSH as its working directory: not armed, not a repository.
    const plain = await mkdtempInRepo('dash-plain-')
    const handler = createDashboardHandler(deps({ ownRoot: plain, home: plain }))
    const res = await call(handler, 'GET', '/devloop/api/projects')
    expect((JSON.parse(res.body) as { value: { projects: unknown[] } }).value.projects).toEqual([])
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

describe('dashboard actions', () => {
  function running() {
    return withTasks(baseState({ lastAction: { type: 'plan' } }), [makeTask({ id: 't1', status: 'ready' })])
  }

  it('checks DSH login before it reads a single byte of the body', async () => {
    const root = await armedProject('dash-act-auth-')
    await saveState(root, running())
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root, requestRejection: () => 401 }))
    const res = await call(handler, 'POST', `/devloop/api/projects/${projectId(root)}/pause`, { revision: 1 })
    expect(res.status).toBe(401)
    expect((await loadState(root, Date.now())).paused).toBeUndefined()
  })

  it('refuses a write that is not JSON, has no revision, or answers with a word that is not an answer', async () => {
    const root = await armedProject('dash-act-bad-')
    await saveState(root, running())
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root }))
    const base = `/devloop/api/projects/${projectId(root)}`
    // A cross-site form can post text/plain without a preflight; JSON it cannot.
    expect((await call(handler, 'POST', `${base}/pause`, 'revision=1', 'text/plain')).status).toBe(415)
    expect((await call(handler, 'POST', `${base}/pause`, {})).status).toBe(400)
    expect((await call(handler, 'POST', `${base}/pause`, { revision: '1' })).status).toBe(400)
    expect((await call(handler, 'POST', `${base}/answer`, { revision: 1, choice: 'rm -rf' })).status).toBe(400)
    expect((await call(handler, 'POST', `${base}/pause`, 'x'.repeat(5000))).status).toBe(400)
    expect((await loadState(root, Date.now())).paused).toBeUndefined()
  })

  it('pauses and resumes through the CLI\'s own functions, and tells the loop', async () => {
    const root = await armedProject('dash-act-ok-')
    const saved = await saveState(root, running())
    const told: string[] = []
    const handler = createDashboardHandler(deps({
      ownRoot: root,
      home: root,
      onOperatorAction: (project, verb) => { told.push(`${project.own ? 'own' : 'other'}:${verb}`) },
    }))
    const base = `/devloop/api/projects/${projectId(root)}`

    const paused = await call(handler, 'POST', `${base}/pause`, { revision: saved.revision })
    expect(paused.status).toBe(200)
    const pausedValue = (JSON.parse(paused.body) as { value: { revision: number } }).value
    expect(pausedValue.revision).toBe(saved.revision + 1)
    expect((await loadState(root, Date.now())).paused?.via).toBe('dashboard')

    const resumed = await call(handler, 'POST', `${base}/resume`, { revision: pausedValue.revision })
    expect(resumed.status).toBe(200)
    expect((await loadState(root, Date.now())).killSwitch).toBe(false)
    expect(told).toEqual(['own:pause', 'own:resume'])
  })

  it('answers 409 to a decision made against a state that has moved, and changes nothing', async () => {
    const root = await armedProject('dash-act-stale-')
    const saved = await saveState(root, running())
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root }))
    const res = await call(handler, 'POST', `/devloop/api/projects/${projectId(root)}/pause`, { revision: saved.revision - 1 })
    expect(res.status).toBe(409)
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('stale')
    expect((await loadState(root, Date.now())).revision).toBe(saved.revision)
  })

  it('answers 422 when there is nothing to answer, and 404 for a project nobody registered', async () => {
    const root = await armedProject('dash-act-422-')
    const saved = await saveState(root, running())
    const handler = createDashboardHandler(deps({ ownRoot: root, home: root }))
    const nothing = await call(handler, 'POST', `/devloop/api/projects/${projectId(root)}/answer`, { revision: saved.revision, choice: 'retry' })
    expect(nothing.status).toBe(422)
    const nobody = await call(handler, 'POST', `/devloop/api/projects/${projectId('/etc')}/pause`, { revision: 1 })
    expect(nobody.status).toBe(404)
  })
})
