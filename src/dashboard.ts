import { constants, lstat, open, readFile } from 'node:fs/promises'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { BudgetLimits } from './config.js'
import { effectiveBudget } from './command.js'
import { gateFor, type Gate, type GateOption } from './gate.js'
import { answerGate, OperatorError, pauseLoop, resumeLoop, type OperatorFailure } from './operator.js'
import { actionKey } from './loop.js'
import { devloopDir, eventsPath, goalPath, loadState, workspaceArmed } from './persist.js'
import { PROGRESS_FILE } from './progress.js'
import { findProject, listProjects, type Project } from './projects.js'
import { diagnoseHalt } from './resume.js'
import type { LoopState, Task } from './types.js'

/**
 * The management page, served by DSH's own webserver behind DSH's own login.
 *
 * Reads are GETs that take no lock and open nothing for writing. The three
 * writes — answer, resume, pause — are POSTs that call the very functions the
 * CLI calls (`operator.ts`), under the same lock, and only for the revision the
 * operator was looking at. The page has no write the CLI does not have.
 *
 * Every request passes `requestRejection` before routing — static assets too —
 * so the page is exactly as reachable as DSH's `/api`: a trusted `Host`, a
 * matching `Origin`, and the signed browser cookie. A loopback check would not
 * do: behind `tailscale serve` every request arrives from `127.0.0.1`.
 */
export const DASHBOARD_PATH = '/devloop'

/** How this process's own loop is doing, as far as the page can tell. */
export type LoopPresence = 'running' | 'stopped' | 'elsewhere'

/** What the page can do. Each one is a CLI verb of the same name. */
export type DashboardVerb = 'answer' | 'resume' | 'pause'

export interface DashboardDeps {
  readonly ownRoot: string
  readonly home: string
  /** Whether this process is ticking a loop for `ownRoot` right now. */
  readonly loopRunning: () => boolean
  readonly requestRejection: (request: { readonly headers: IncomingHttpHeaders }) => 401 | 403 | undefined
  readonly assets: DashboardAssets
  readonly now?: () => number
  /**
   * Told after a write succeeds, so the process running that project's loop
   * can act at once: abandon the dispatch in flight on a pause, tick on the
   * rest. A project run by another process notices on its own next tick.
   */
  readonly onOperatorAction?: (project: Project, verb: DashboardVerb) => void
}

export interface DashboardAssets {
  readonly html: string
  readonly js: string
  readonly css: string
}

export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly own: boolean
  readonly loop: LoopPresence
  /** Has a `.devloop/GOAL.md`; without one no loop runs. */
  readonly armed: boolean
  readonly revision: number | null
  readonly lastAction: string | null
  readonly halted: boolean
  /** Halted by an operator's pause rather than by the loop itself. */
  readonly paused: boolean
  readonly haltReasons: readonly string[]
  readonly question: string | null
  readonly taskCounts: Readonly<Record<string, number>>
  readonly costUsdSession: number | null
  readonly costUsdDay: number | null
  readonly updatedAt: string | null
  /** Why the page could not read this project; the rest is then null. */
  readonly error: string | null
}

export interface ProjectDetail extends ProjectSummary {
  readonly goal: string | null
  readonly progress: string | null
  readonly tasks: readonly TaskView[]
  readonly gate: Gate | null
  readonly supervisor: LoopState['supervisor']
  readonly killSwitch: boolean | null
  readonly acknowledged: LoopState['acknowledged'] | null
  readonly pause: LoopState['paused'] | null
  readonly budget: { readonly source: string, readonly limits: BudgetLimits } | null
  readonly lastProgressAt: string | null
  readonly events: readonly EventView[]
}

export type TaskView = Pick<Task,
  'id' | 'title' | 'tier' | 'status' | 'risk' | 'attempts' | 'reviewCycles'
  | 'allowedPaths' | 'acceptance' | 'lastReviewVerdict' | 'implementer' | 'reviewer'>

export interface EventView {
  readonly revision: number | null
  readonly at: string | null
  readonly action: string | null
}

const GOAL_MAX_BYTES = 64 * 1024
const PROGRESS_MAX_BYTES = 64 * 1024
/** A record carries a whole state snapshot, so the tail is read in bytes, not lines. */
const EVENTS_TAIL_BYTES = 512 * 1024
const EVENTS_SHOWN = 40

export async function summarizeProject(project: Project, deps: Pick<DashboardDeps, 'loopRunning'>, now: number): Promise<ProjectSummary> {
  return (await readProject(project, deps, now, false)).summary
}

export async function describeProject(project: Project, deps: Pick<DashboardDeps, 'loopRunning'>, now: number): Promise<ProjectDetail> {
  const { summary, extra } = await readProject(project, deps, now, true)
  return { ...summary, ...(extra ?? emptyDetail()) }
}

async function readProject(
  project: Project,
  deps: Pick<DashboardDeps, 'loopRunning'>,
  now: number,
  full: boolean,
): Promise<{ summary: ProjectSummary, extra: Omit<ProjectDetail, keyof ProjectSummary> | null }> {
  const loop: LoopPresence = project.own ? (deps.loopRunning() ? 'running' : 'stopped') : 'elsewhere'
  const base = {
    id: project.id,
    name: project.name,
    root: project.root,
    own: project.own,
    loop,
  }
  const blank: ProjectSummary = {
    ...base,
    armed: false,
    revision: null,
    lastAction: null,
    halted: false,
    paused: false,
    haltReasons: [],
    question: null,
    taskCounts: {},
    costUsdSession: null,
    costUsdDay: null,
    updatedAt: null,
    error: null,
  }

  try {
    await lstat(project.root)
  } catch {
    return { summary: { ...blank, error: 'directory not found' }, extra: null }
  }
  // Everything below reads inside `.devloop/`, and only once `workspaceArmed`
  // has refused a symlinked directory or GOAL.md: a registered project must not
  // be a way to serve a file from somewhere else.
  if (!await workspaceArmed(project.root)) return { summary: blank, extra: null }

  try {
    const state = await loadState(project.root, now)
    const budget = await effectiveBudget(project.root)
    const diagnosis = diagnoseHalt(state, budget.limits, now)
    const gate = gateFor(state, budget.limits, now)
    const summary: ProjectSummary = {
      ...blank,
      armed: true,
      revision: state.revision,
      lastAction: actionKey(state.lastAction),
      halted: diagnosis.halted,
      paused: state.paused !== undefined,
      haltReasons: diagnosis.reasons,
      question: gate?.question ?? null,
      taskCounts: countByStatus(state.tasks),
      costUsdSession: state.usage.costUsdSession,
      costUsdDay: state.usage.costUsdDay,
      updatedAt: state.updatedAt,
    }
    if (!full) return { summary, extra: null }
    return {
      summary,
      extra: {
        goal: await readHead(goalPath(project.root), GOAL_MAX_BYTES),
        progress: await readHead(join(devloopDir(project.root), PROGRESS_FILE), PROGRESS_MAX_BYTES),
        tasks: state.tasks.map(taskView),
        gate,
        supervisor: state.supervisor,
        killSwitch: state.killSwitch,
        acknowledged: state.acknowledged ?? null,
        pause: state.paused ?? null,
        budget,
        lastProgressAt: new Date(state.usage.lastProgressAt).toISOString(),
        events: await readEventTail(eventsPath(project.root)),
      },
    }
  } catch (error) {
    return { summary: { ...blank, armed: true, error: messageOf(error) }, extra: null }
  }
}

function emptyDetail(): Omit<ProjectDetail, keyof ProjectSummary> {
  return {
    goal: null,
    progress: null,
    tasks: [],
    gate: null,
    supervisor: null,
    killSwitch: null,
    acknowledged: null,
    pause: null,
    budget: null,
    lastProgressAt: null,
    events: [],
  }
}

function taskView(task: Task): TaskView {
  return {
    id: task.id,
    title: task.title,
    tier: task.tier,
    status: task.status,
    risk: task.risk,
    attempts: task.attempts,
    reviewCycles: task.reviewCycles,
    allowedPaths: task.allowedPaths,
    acceptance: task.acceptance,
    ...(task.lastReviewVerdict === undefined ? {} : { lastReviewVerdict: task.lastReviewVerdict }),
    ...(task.implementer === undefined ? {} : { implementer: task.implementer }),
    ...(task.reviewer === undefined ? {} : { reviewer: task.reviewer }),
  }
}

function countByStatus(tasks: readonly Task[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
  return counts
}

/**
 * Open a regular file without following a symlink at the last hop, and read at
 * most `max` bytes of it. `null` for anything that is not a plain file.
 */
async function openPlain(path: string) {
  try {
    const meta = await lstat(path)
    if (!meta.isFile() || meta.isSymbolicLink()) return null
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
}

async function readHead(path: string, max: number): Promise<string | null> {
  const handle = await openPlain(path)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(max)
    const { bytesRead } = await handle.read(buffer, 0, max, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function readEventTail(path: string): Promise<EventView[]> {
  const handle = await openPlain(path)
  if (!handle) return []
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - EVENTS_TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    // A tail that starts mid-file starts mid-record.
    if (start > 0) lines.shift()
    const events: EventView[] = []
    for (const line of lines) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        // Only the envelope: each record also carries a full state snapshot,
        // which the detail view already shows once, current.
        events.push({
          revision: typeof record.revision === 'number' ? record.revision : null,
          at: typeof record.at === 'string' ? record.at : null,
          action: typeof record.action === 'string' ? record.action : null,
        })
      } catch {
        // A torn final append is the journal's business, not the page's.
      }
    }
    return events.slice(-EVENTS_SHOWN).reverse()
  } finally {
    await handle.close()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- HTTP ---------------------------------------------------------------

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': CSP,
}

export function createDashboardHandler(deps: DashboardDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = deps.now ?? Date.now
  return async (req, res) => {
    const rejection = deps.requestRejection(req)
    if (rejection === 403) return send(res, req, 403, 'text/plain; charset=utf-8', 'forbidden\n')
    if (rejection === 401) return send(res, req, 401, 'text/html; charset=utf-8', LOGIN_HINT)

    const path = new URL(req.url ?? '/', 'http://dashboard.invalid').pathname
    const action = ACTION_ROUTE.exec(path)
    if (action) {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return send(res, req, 405, 'text/plain; charset=utf-8', 'method not allowed\n')
      }
      return act(req, res, deps, now, action[1] as string, action[2] as DashboardVerb)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      return send(res, req, 405, 'text/plain; charset=utf-8', 'method not allowed\n')
    }

    if (path === DASHBOARD_PATH) {
      res.writeHead(308, { ...COMMON_HEADERS, location: `${DASHBOARD_PATH}/` })
      res.end()
      return
    }
    if (path === `${DASHBOARD_PATH}/`) return send(res, req, 200, 'text/html; charset=utf-8', deps.assets.html)
    if (path === `${DASHBOARD_PATH}/app.js`) return send(res, req, 200, 'text/javascript; charset=utf-8', deps.assets.js)
    if (path === `${DASHBOARD_PATH}/app.css`) return send(res, req, 200, 'text/css; charset=utf-8', deps.assets.css)

    try {
      if (path === `${DASHBOARD_PATH}/api/projects`) {
        const list = await listProjects(deps.ownRoot, deps.home)
        const projects = await Promise.all(list.projects.map(project => summarizeProject(project, deps, now())))
        return json(res, req, 200, { ok: true, value: { projects, registryError: list.registryError } })
      }
      const prefix = `${DASHBOARD_PATH}/api/projects/`
      if (path.startsWith(prefix)) {
        const id = path.slice(prefix.length)
        const project = findProject(await listProjects(deps.ownRoot, deps.home), id)
        if (!project) return json(res, req, 404, { ok: false, error: { code: 'not-found', message: 'no such project' } })
        return json(res, req, 200, { ok: true, value: await describeProject(project, deps, now()) })
      }
    } catch (error) {
      return json(res, req, 500, { ok: false, error: { code: 'internal', message: messageOf(error) } })
    }
    return send(res, req, 404, 'text/plain; charset=utf-8', 'not found\n')
  }
}

const ACTION_ROUTE = new RegExp(`^${DASHBOARD_PATH}/api/projects/([0-9a-f]{12})/(answer|resume|pause)$`)
const MAX_BODY_BYTES = 4 * 1024
const ANSWERS = new Set<GateOption['key']>(['retry', 'review', 'accept', 'stop'])

const FAILURE_STATUS: Readonly<Record<OperatorFailure, number>> = {
  stale: 409,
  busy: 503,
  refused: 422,
}

async function act(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardDeps,
  now: () => number,
  id: string,
  verb: DashboardVerb,
): Promise<void> {
  const fail = (status: number, code: string, message: string) =>
    json(res, req, status, { ok: false, error: { code, message } })

  // Defence in depth beside DSH's Origin check: a cross-site form cannot send
  // this content type without a preflight the page never answers.
  const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json') return fail(415, 'bad-request', 'send application/json')

  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (error) {
    return fail(400, 'bad-request', messageOf(error))
  }
  const revision = body.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    // Required, not optional: a write from the page is always a reply to a
    // particular state, and one with no revision could land on any state.
    return fail(400, 'bad-request', 'revision is required: the state you were looking at')
  }
  const choice = body.choice
  if (verb === 'answer' && (typeof choice !== 'string' || !ANSWERS.has(choice as GateOption['key']))) {
    return fail(400, 'bad-request', 'choice must be one of retry, review, accept, stop')
  }

  const project = findProject(await listProjects(deps.ownRoot, deps.home), id)
  if (!project) return fail(404, 'not-found', 'no such project')
  if (!await workspaceArmed(project.root)) return fail(422, 'refused', 'this project has no .devloop/GOAL.md')

  const { limits } = await effectiveBudget(project.root)
  const options = { via: 'dashboard' as const, expectedRevision: revision, now }
  try {
    let value: Record<string, unknown>
    if (verb === 'answer') {
      const outcome = await answerGate(project.root, choice as GateOption['key'], limits, options)
      value = { revision: outcome.saved.revision, stillBlocked: outcome.stillBlocked, declined: outcome.declined }
    } else if (verb === 'resume') {
      const outcome = await resumeLoop(project.root, {}, limits, options)
      value = { revision: outcome.saved.revision, stillBlocked: outcome.stillBlocked, cleared: outcome.before.reasons }
    } else {
      const outcome = await pauseLoop(project.root, limits, options)
      value = { revision: outcome.saved.revision, stillBlocked: outcome.stillBlocked }
    }
    deps.onOperatorAction?.(project, verb)
    return json(res, req, 200, { ok: true, value })
  } catch (error) {
    if (error instanceof OperatorError) return fail(FAILURE_STATUS[error.code], error.code, error.message)
    return fail(500, 'internal', messageOf(error))
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error(`body over ${MAX_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('body is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('body must be a JSON object')
  return value as Record<string, unknown>
}

function send(res: ServerResponse, req: IncomingMessage, status: number, type: string, body: string): void {
  res.writeHead(status, {
    ...COMMON_HEADERS,
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function json(res: ServerResponse, req: IncomingMessage, status: number, value: unknown): void {
  send(res, req, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

/** Shown instead of the page to a browser without DSH's login cookie. */
const LOGIN_HINT = `<!doctype html><meta charset="utf-8"><title>DevLoop — 未登录</title>
<p>还没有登录 DSH。用 <code>dsh web</code> 启动时打印的 <code>?token=</code> 链接打开一次 DSH 首页（主机名和端口换成你现在用的这个），然后回到 <code>/devloop/</code>。</p>
<p>Not signed in to DSH. Open the <code>?token=</code> link <code>dsh web</code> printed once, on this same host and port, then come back to <code>/devloop/</code>.</p>
`

// ---- mounting -----------------------------------------------------------

interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface ConnectionLike {
  requestRejection(request: { readonly headers: IncomingHttpHeaders }): 401 | 403 | undefined
}

/** Where the page's files live in the published package. */
export function dashboardAssetsDir(): string {
  return fileURLToPath(new URL('../dashboard/', import.meta.url))
}

export async function loadDashboardAssets(dir = dashboardAssetsDir()): Promise<DashboardAssets> {
  const [html, js, css] = await Promise.all([
    readFile(join(dir, 'index.html'), 'utf8'),
    readFile(join(dir, 'app.js'), 'utf8'),
    readFile(join(dir, 'app.css'), 'utf8'),
  ])
  return { html, js, css }
}

/**
 * Mount the page wherever DSH has a webserver and a browser login to guard it:
 * the web profile. Elsewhere — `tui`, `headless` — the two services are absent,
 * the callback never runs, and the loop is unaffected.
 */
export function mountDashboard(
  ctx: Context,
  deps: Omit<DashboardDeps, 'requestRejection' | 'assets'>,
): void {
  ctx.inject(['webServer', 'connection'], (inner: Context) => {
    const host = inner as unknown as { webServer: WebServerLike, connection: ConnectionLike }
    let unregister: (() => void) | null = null
    let disposed = false
    inner.effect(() => {
      void loadDashboardAssets().then((assets) => {
        if (disposed) return
        unregister = host.webServer.register({
          kind: 'prefix',
          path: DASHBOARD_PATH,
          handler: createDashboardHandler({
            ...deps,
            assets,
            requestRejection: request => host.connection.requestRejection(request),
          }),
        })
        inner.logger.info(`[dsh-devloop] dashboard at ${DASHBOARD_PATH}/`)
      }).catch((error: unknown) => {
        inner.logger.error('[dsh-devloop] dashboard assets unreadable; page not mounted', error)
      })
      return () => {
        disposed = true
        unregister?.()
      }
    }, 'devloop: dashboard route')
  })
}
