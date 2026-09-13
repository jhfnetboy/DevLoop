import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { emptyUsage } from '../src/budget.ts'
import { resolveConfig } from '../src/config.ts'
import { createDashboardHandler, describeProject, type DashboardDeps, type ProjectControl } from '../src/dashboard.ts'
import { pauseLoop } from '../src/operator.ts'
import { emptyState, loadState, saveState } from '../src/persist.ts'
import {
  armProject,
  browseDirectory,
  browseRoot,
  listProjects,
  projectId,
  registerProject,
  registryPath,
  unregisterProject,
  validateProjectRoot,
} from '../src/projects.ts'
import DevloopService, { LoopShared, ProjectLoop } from '../src/service.ts'
import { NoopBackend } from '../src/backend.ts'
import { initGitRepo, makeTask, mkdtempInRepo } from './helpers.ts'

const execFileAsync = promisify(execFile)

async function repo(prefix: string): Promise<string> {
  const root = await mkdtempInRepo(prefix)
  await initGitRepo(root)
  return realpath(root)
}

/** Outside every repository — `.tmp/` is inside this one, which git would find. */
async function outsideAnyRepo(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function home(): Promise<string> {
  return mkdtempInRepo('projects-home-')
}

describe('registering a project', () => {
  it('accepts only the top level of an existing git repository, by realpath', async () => {
    const root = await repo('reg-ok-')
    expect(await validateProjectRoot(root)).toBe(root)
    await expect(validateProjectRoot('relative/path')).rejects.toThrow(/absolute/)
    await expect(validateProjectRoot(join(root, 'missing'))).rejects.toThrow(/does not exist/)
    const plain = await outsideAnyRepo('reg-plain-')
    await expect(validateProjectRoot(plain)).rejects.toThrow(/not a git repository/)
    await mkdir(join(root, 'sub'))
    await expect(validateProjectRoot(join(root, 'sub'))).rejects.toThrow(/register the repository's top level/)
  })

  it('refuses a repository whose .devloop is a symlink', async () => {
    const root = await repo('reg-link-')
    const elsewhere = await mkdtempInRepo('reg-elsewhere-')
    await symlink(elsewhere, join(root, '.devloop'))
    await expect(validateProjectRoot(root)).rejects.toThrow(/real directory/)
  })

  it('records the realpath once, keeps what it does not understand, and refuses a duplicate', async () => {
    const dir = await home()
    const root = await repo('reg-write-')
    await mkdir(join(dir, 'devloop'))
    await writeFile(registryPath(dir), JSON.stringify({ projects: [{ root: '/kept/as/is', note: 'mine' }] }), 'utf8')
    const own = await mkdtempInRepo('reg-own-')

    expect(await registerProject(dir, own, root)).toBe(root)
    const written = JSON.parse(await readFile(registryPath(dir), 'utf8')) as { projects: Array<Record<string, unknown>> }
    expect(written.projects[0]).toEqual({ root: '/kept/as/is', note: 'mine' })
    expect(written.projects[1]?.root).toBe(root)
    await expect(registerProject(dir, own, root)).rejects.toThrow(/already registered/)
    await expect(registerProject(dir, root, root)).rejects.toThrow(/own root/)
  })

  it('will not overwrite a registry it cannot parse', async () => {
    const dir = await home()
    await mkdir(join(dir, 'devloop'))
    await writeFile(registryPath(dir), '{ hand edited, broken', 'utf8')
    await expect(registerProject(dir, '/own', await repo('reg-broken-'))).rejects.toThrow(/fix it by hand/)
    expect(await readFile(registryPath(dir), 'utf8')).toBe('{ hand edited, broken')
  })

  it('forgets a project without touching its files', async () => {
    const dir = await home()
    const root = await repo('reg-forget-')
    await armProject(root, 'Ship it')
    await registerProject(dir, '/own', root)
    await unregisterProject(dir, root)
    expect((await listProjects('/own', dir)).projects.map(p => p.root)).not.toContain(root)
    expect(await readFile(join(root, '.devloop', 'GOAL.md'), 'utf8')).toBe('Ship it\n')
  })
})

describe('arming a project', () => {
  it('writes GOAL.md, which is what starts its loop', async () => {
    const root = await repo('arm-ok-')
    await armProject(root, '  Add a /healthz endpoint  ')
    expect(await readFile(join(root, '.devloop', 'GOAL.md'), 'utf8')).toBe('Add a /healthz endpoint\n')
  })

  it('never replaces a goal a loop may already be working toward', async () => {
    const root = await repo('arm-twice-')
    await armProject(root, 'first')
    await expect(armProject(root, 'second')).rejects.toThrow(/already has a GOAL.md/)
    expect(await readFile(join(root, '.devloop', 'GOAL.md'), 'utf8')).toBe('first\n')
  })

  it('refuses an empty goal, and a directory that is not a repository', async () => {
    await expect(armProject(await repo('arm-empty-'), '   ')).rejects.toThrow(/empty/)
    await expect(armProject(await outsideAnyRepo('arm-plain-'), 'goal')).rejects.toThrow(/not a git repository/)
  })

  it('does not follow a GOAL.md symlink planted before it', async () => {
    const root = await repo('arm-link-')
    const target = join(await mkdtempInRepo('arm-target-'), 'victim.txt')
    await mkdir(join(root, '.devloop'))
    await symlink(target, join(root, '.devloop', 'GOAL.md'))
    await expect(armProject(root, 'goal')).rejects.toThrow()
    await expect(readFile(target, 'utf8')).rejects.toThrow()
  })
})

describe('an unarmed root', () => {
  it('is left without a .devloop/, even by a running loop', async () => {
    // launchd starts DSH in $HOME; the budget snapshot used to be written at
    // start, so $HOME grew a .devloop/ it had no use for.
    const root = await outsideAnyRepo('unarmed-root-')
    const loop = new ProjectLoop({ info: () => {}, error: () => {} } as never, resolveConfig({ root, tickIntervalMs: 60_000 }), new NoopBackend())
    loop.start()
    await loop.tick()
    // The snapshot was fire-and-forget; give it time to land, or this passes
    // without the fix too (it did, the first time this test was written).
    await new Promise(resolve => setTimeout(resolve, 300))
    loop.stop()
    await expect(readFile(join(root, '.devloop', 'BUDGET.json'), 'utf8')).rejects.toThrow()
  })
})

describe('what loops share', () => {
  const loop = (usage: ReturnType<typeof emptyUsage> | null): ProjectLoop => {
    const l = new ProjectLoop({ info: () => {}, error: () => {} } as never, resolveConfig({ root: '/x' }), new NoopBackend())
    l.lastUsage = usage
    return l
  }

  it('bounds concurrent ticks across projects', () => {
    const shared = new LoopShared(2, 100)
    expect(shared.admit(0)).toBe(true)
    expect(shared.admit(0)).toBe(true)
    expect(shared.admit(0)).toBe(false)
    shared.release()
    expect(shared.admit(0)).toBe(true)
  })

  it('caps the day\'s combined spend only once there is more than one project', () => {
    const now = Date.UTC(2026, 8, 10, 12)
    const shared = new LoopShared(10, 5)
    shared.add(loop({ ...emptyUsage(now), costUsdDay: 6 }))
    // Alone, a project's own cap halts it with a gate that names why; a shared
    // cap at the same figure would only turn that halt into silence.
    expect(shared.cap()).toBeNull()
    expect(shared.admit(now)).toBe(true)
    shared.release()

    shared.add(loop({ ...emptyUsage(now), costUsdDay: 1 }))
    expect(shared.cap()).toBe(5)
    expect(shared.spentToday(now)).toBe(7)
    expect(shared.admit(now)).toBe(false)
  })

  it('does not count yesterday\'s spend against today', () => {
    const yesterday = Date.UTC(2026, 8, 9, 23)
    const today = Date.UTC(2026, 8, 10, 1)
    const shared = new LoopShared(10, 5)
    shared.add(loop({ ...emptyUsage(yesterday), costUsdDay: 50 }))
    shared.add(loop(null))
    expect(shared.spentToday(today)).toBe(0)
    expect(shared.admit(today)).toBe(true)
  })

  it('defaults the shared cap to one project\'s daily cap', () => {
    const config = resolveConfig({})
    expect(config.maxCostUsdPerDayAllProjects).toBe(0)
  })
})

describe('the service runs every registered project', () => {
  const services: DevloopService[] = []
  const saved = process.env.DSH_HOME
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
    process.env.DSH_HOME = saved
  })

  it('ticks a registered project\'s loop, and forgets it when unregistered', async () => {
    const dir = await home()
    process.env.DSH_HOME = dir
    const other = await repo('svc-other-')
    await armProject(other, 'plan something')
    await registerProject(dir, '/unused', other)

    const own = await mkdtempInRepo('svc-own-')
    const service = new DevloopService(new Context(), resolveConfig({ root: own, tickIntervalMs: 60_000 }))
    services.push(service)
    // The registered loop ticks on start; its first act is to decide to plan.
    const deadline = Date.now() + 10_000
    let state = await loadState(other, Date.now())
    while (state.lastAction.type !== 'plan' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
      state = await loadState(other, Date.now())
    }
    expect(state.lastAction.type).toBe('plan')
  })

  it('starts nothing from a registry read that finishes after it was stopped', async () => {
    const dir = await home()
    process.env.DSH_HOME = dir
    const other = await repo('svc-late-')
    await armProject(other, 'plan something')
    await registerProject(dir, '/unused', other)

    const service = new DevloopService(new Context(), resolveConfig({ root: await mkdtempInRepo('svc-own2-'), tickIntervalMs: 60_000 }))
    // The registry is read asynchronously after start; stopping before it
    // lands must not leave a loop behind that nothing will ever stop.
    service.stop()
    await new Promise(resolve => setTimeout(resolve, 500))
    await expect(readFile(join(other, '.devloop', 'STATE.json'), 'utf8')).rejects.toThrow()
  })
})

describe('browsing for a repository', () => {
  it('lists directories only, hides dot-directories, and marks git repositories', async () => {
    const top = await realpath(await outsideAnyRepo('browse-'))
    await mkdir(join(top, 'org', 'repo'), { recursive: true })
    await initGitRepo(join(top, 'org', 'repo'))
    await mkdir(join(top, 'org', 'notes'))
    await mkdir(join(top, '.cache'))
    await writeFile(join(top, 'file.txt'), 'x', 'utf8')

    const root = await browseDirectory(top, [])
    expect(root.entries.map(e => e.name)).toEqual(['org'])
    const org = await browseDirectory(top, ['org'])
    expect(org.entries).toEqual([
      { name: 'notes', root: join(top, 'org', 'notes'), repo: false },
      { name: 'repo', root: join(top, 'org', 'repo'), repo: true },
    ])
  })

  it('never lists outside the browse root, by segment or by symlink', async () => {
    const top = await realpath(await outsideAnyRepo('browse-escape-'))
    const elsewhere = await outsideAnyRepo('browse-elsewhere-')
    await mkdir(join(top, 'org'))
    await symlink(elsewhere, join(top, 'org', 'out'))
    await symlink(elsewhere, join(top, 'away'))

    expect((await browseDirectory(top, ['org'])).entries).toEqual([])
    await expect(browseDirectory(top, ['away'])).rejects.toThrow(/no such directory/)
    await expect(browseDirectory(top, ['..'])).rejects.toThrow(/bad path/)
    await expect(browseDirectory(top, ['org/..'])).rejects.toThrow(/bad path/)
    await expect(browseDirectory(join(top, 'missing'), [])).rejects.toThrow(/DEVLOOP_BROWSE_ROOT/)
  })

  it('defaults to ~/Dev and honours DEVLOOP_BROWSE_ROOT', () => {
    expect(browseRoot({})).toMatch(/\/Dev$/)
    expect(browseRoot({ DEVLOOP_BROWSE_ROOT: '/srv/code' })).toBe('/srv/code')
  })
})

describe('dashboard project routes', () => {
  function control(): ProjectControl & { added: string[], removed: string[] } {
    const added: string[] = []
    const removed: string[] = []
    return {
      added,
      removed,
      addProject: root => { added.push(root) },
      removeProject: root => { removed.push(root) },
      spend: () => ({ costUsdDay: 1.5, cap: 20 }),
    }
  }

  async function post(handler: ReturnType<typeof createDashboardHandler>, url: string, body: unknown) {
    const out = { status: 0, body: '' }
    const payload = JSON.stringify(body)
    const req = {
      method: 'POST',
      url,
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(payload) },
    }
    const res = {
      setHeader() {},
      writeHead(status: number) { out.status = status },
      end(text?: string) { out.body = text ?? '' },
    }
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    return { status: out.status, json: JSON.parse(out.body || '{}') as { ok: boolean, value?: Record<string, unknown>, error?: { message: string } } }
  }

  function handlerFor(ownRoot: string, homeDir: string, ctl: ProjectControl, extra: Partial<DashboardDeps> = {}): ReturnType<typeof createDashboardHandler> {
    const deps: DashboardDeps = {
      ...extra,
      ownRoot,
      home: homeDir,
      presence: () => 'running',
      requestRejection: () => undefined,
      assets: { html: '', js: '', css: '' },
      control: ctl,
    }
    return createDashboardHandler(deps)
  }

  it('registers, starts, and refuses to remove a running loop until it is paused', async () => {
    const dir = await home()
    const own = await mkdtempInRepo('route-own-')
    const root = await repo('route-proj-')
    const ctl = control()
    const handler = handlerFor(own, dir, ctl)

    const registered = await post(handler, '/devloop/api/projects', { root })
    expect(registered.status).toBe(200)
    expect(ctl.added).toEqual([root])
    const id = projectId(root)
    expect(registered.json.value?.id).toBe(id)

    const refused = await post(handler, '/devloop/api/projects', { root: own })
    expect(refused.status).toBe(422)

    // On its trunk the start is refused before anything is written or paid for.
    const onMain = await post(handler, `/devloop/api/projects/${id}/start`, { goal: 'Add /healthz' })
    expect(onMain.status).toBe(422)
    expect(onMain.json.error?.message).toMatch(/switch -c devloop/)
    await expect(readFile(join(root, '.devloop', 'GOAL.md'), 'utf8')).rejects.toThrow()

    await execFileAsync('git', ['-C', root, 'switch', '-q', '-c', 'devloop/healthz'])
    const started = await post(handler, `/devloop/api/projects/${id}/start`, { goal: 'Add /healthz' })
    expect(started.status).toBe(200)
    expect(await readFile(join(root, '.devloop', 'GOAL.md'), 'utf8')).toBe('Add /healthz\n')
    expect((await post(handler, `/devloop/api/projects/${id}/start`, { goal: 'again' })).status).toBe(422)

    // Give it a state that is running, as its loop would have.
    const state = await saveState(root, { ...emptyState(Date.now()), lastAction: { type: 'plan' }, tasks: [makeTask({ id: 't1', status: 'ready' })] })
    const early = await post(handler, `/devloop/api/projects/${id}/unregister`, {})
    expect(early.status).toBe(422)
    expect(early.json.error?.message).toMatch(/pause/)

    await pauseLoop(root, resolveConfig({}).budget, { via: 'dashboard', expectedRevision: state.revision })
    const removed = await post(handler, `/devloop/api/projects/${id}/unregister`, {})
    expect(removed.status).toBe(200)
    expect(ctl.removed).toEqual([root])
    expect((await listProjects(own, dir)).projects.map(p => p.root)).not.toContain(root)
  })

  it('starts the next goal on a finished project, and refuses one that is not finished, stale, or waiting on its release', async () => {
    const dir = await home()
    const root = await repo('route-next-')
    await execFileAsync('git', ['-C', root, 'switch', '-q', '-c', 'devloop/work'])
    const woken: string[] = []
    const plain = handlerFor(await mkdtempInRepo('route-own-'), dir, control(), { onOperatorAction: (_project, verb) => woken.push(verb) })
    await post(plain, '/devloop/api/projects', { root })
    const id = projectId(root)
    await post(plain, `/devloop/api/projects/${id}/start`, { goal: 'Goal one' })
    const running = await saveState(root, { ...emptyState(Date.now()), lastAction: { type: 'plan' }, tasks: [makeTask({ id: 't1', status: 'ready' })] })
    const early = await post(plain, `/devloop/api/projects/${id}/next`, { goal: 'Goal two', revision: running.revision })
    expect(early.status).toBe(422)
    expect(early.json.error?.message).toMatch(/not finished/)

    const done = await saveState(root, { ...running, goalCompleted: true, killSwitch: true, lastAction: { type: 'stop', reason: 'goal_complete' }, tasks: [makeTask({ id: 't1', status: 'done' })], release: { number: 5, merged: false } })
    expect((await describeProject({ id, root, name: 'n', own: false }, { presence: () => 'running' }, Date.now())).readiness?.ready).toBe(true)
    expect((await post(plain, `/devloop/api/projects/${id}/next`, { goal: 'Goal two', revision: done.revision - 1 })).status).toBe(409)
    expect((await post(plain, `/devloop/api/projects/${id}/next`, { goal: 'Goal two' })).status).toBe(400)
    // Where the forge merges, the next goal waits for the finished one's release.
    const forge = handlerFor(await mkdtempInRepo('route-own-'), dir, control(), { forgeMerges: true })
    const waiting = await post(forge, `/devloop/api/projects/${id}/next`, { goal: 'Goal two', revision: done.revision })
    expect(waiting.status).toBe(422)
    expect(waiting.json.error?.message).toMatch(/release pull request has not merged/)

    woken.length = 0
    const next = await post(plain, `/devloop/api/projects/${id}/next`, { goal: 'Goal two', revision: done.revision })
    expect(next.status).toBe(200)
    expect(next.json.value).toMatchObject({ id, goal: 2, revision: done.revision + 1 })
    // The loop halted on the finished goal is woken to plan the next one.
    expect(woken).toEqual(['resume'])
    expect(await readFile(join(root, '.devloop', 'GOAL.md'), 'utf8')).toBe('Goal two\n')
    expect(await readFile(join(root, '.devloop', 'archive', '0001', 'GOAL.md'), 'utf8')).toBe('Goal one\n')
    const detail = await describeProject({ id, root, name: 'n', own: false }, { presence: () => 'running' }, Date.now())
    expect(detail).toMatchObject({ goalNumber: 2, release: null, completed: false })
  })

  it('never removes the process\'s own root', async () => {
    const own = await repo('route-self-')
    const handler = handlerFor(own, await home(), control())
    const res = await post(handler, `/devloop/api/projects/${projectId(own)}/unregister`, {})
    expect(res.status).toBe(422)
  })

  it('lists one level below the browse root, marking repositories and ones already added', async () => {
    const top = await realpath(await outsideAnyRepo('browse-route-'))
    await mkdir(join(top, 'org', 'app'), { recursive: true })
    await initGitRepo(join(top, 'org', 'app'))
    await mkdir(join(top, 'org', 'lib'), { recursive: true })
    await initGitRepo(join(top, 'org', 'lib'))
    const own = await repo('browse-own-')
    const dir = await home()
    const ctl = control()
    const handler = createDashboardHandler({
      ownRoot: own,
      home: dir,
      presence: () => 'running',
      requestRejection: () => undefined,
      assets: { html: '', js: '', css: '' },
      control: ctl,
      browseRoot: top,
    })
    await registerProject(dir, own, join(top, 'org', 'lib'))
    const get = async (url: string) => {
      const out = { status: 0, body: '' }
      const req = { method: 'GET', url, headers: {} }
      const res = { setHeader() {}, writeHead(status: number) { out.status = status }, end(text?: string) { out.body = text ?? '' } }
      await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
      return { status: out.status, json: JSON.parse(out.body) as { value?: { entries: { name: string, repo: boolean, registered: boolean }[] } } }
    }

    const level = await get('/devloop/api/browse?path=org')
    expect(level.status).toBe(200)
    expect(level.json.value?.entries.map(e => [e.name, e.repo, e.registered])).toEqual([
      ['app', true, false],
      ['lib', true, true],
    ])
    expect((await get('/devloop/api/browse?path=..')).status).toBe(422)
  })

  it('guards the browse route like every other: login, method, and a process that can add', async () => {
    const top = await realpath(await outsideAnyRepo('browse-guard-'))
    await mkdir(join(top, 'org'))
    const own = await repo('browse-guard-own-')
    const base = { ownRoot: own, home: await home(), presence: () => 'running' as const, assets: { html: '', js: '', css: '' } }
    const status = async (overrides: Partial<DashboardDeps>, method = 'GET', url = '/devloop/api/browse?path=org') => {
      const out = { status: 0, body: '' }
      const handler = createDashboardHandler({ ...base, requestRejection: () => undefined, control: control(), browseRoot: top, ...overrides })
      const req = { method, url, headers: {}, async *[Symbol.asyncIterator]() {} }
      const res = { setHeader() {}, writeHead(code: number) { out.status = code }, end(text?: string) { out.body = text ?? '' } }
      await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
      return out
    }

    expect((await status({})).status).toBe(200)
    const unauthenticated = await status({ requestRejection: () => 401 })
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.body).not.toContain(top)
    expect((await status({ requestRejection: () => 403 })).status).toBe(403)
    expect((await status({}, 'POST')).status).toBe(405)
    expect((await status({ control: undefined })).status).toBe(501)
    expect((await status({ browseRoot: undefined })).status).toBe(501)
    expect((await status({}, 'GET', '/devloop/api/browse?path=missing')).status).toBe(422)
    expect((await status({ browseRoot: join(top, 'gone') })).status).toBe(422)
  })

  it('reports the combined spend with the list', async () => {
    const own = await repo('route-spend-')
    const handler = handlerFor(own, await home(), control())
    const out = { body: '' }
    const req = { method: 'GET', url: '/devloop/api/projects', headers: {} }
    const res = { setHeader() {}, writeHead() {}, end(text?: string) { out.body = text ?? '' } }
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    expect((JSON.parse(out.body) as { value: { global: unknown } }).value.global).toEqual({ costUsdDay: 1.5, cap: 20 })
  })
})
