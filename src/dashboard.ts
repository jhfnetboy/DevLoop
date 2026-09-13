import { constants, lstat, open, readFile } from 'node:fs/promises'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { BudgetLimits } from './config.js'
import { effectiveBudget } from './command.js'
import { gateFor, type Gate, type GateOption } from './gate.js'
import { goalNumber, startNextGoal } from './goals.js'
import { answerGate, OperatorError, pauseLoop, resumeLoop, type OperatorFailure } from './operator.js'
import { actionKey } from './loop.js'
import { attentionFor, type AttentionLane } from './attention.js'
import { devloopDir, eventsPath, goalPath, loadState, workspaceArmed } from './persist.js'
import { PROGRESS_FILE } from './progress.js'
import { readPrLog, type PrLogEntry } from './prlog.js'
import {
  armProject,
  browseDirectory,
  findProject,
  listProjects,
  MAX_GOAL_BYTES,
  ProjectError,
  projectId,
  registerProject,
  unregisterProject,
  validateProjectRoot,
  type Project,
} from './projects.js'
import { inspectReadiness, readinessRefusal, readPlanningDocuments, type PlanningDocument, type Readiness } from './readiness.js'
import { diagnoseHalt, type HaltDetail } from './resume.js'
import { confirmedBranches, runCleanup, statusView, UnreadableStateError } from './status-routes.js'
import type { LoopState, Release, Task } from './types.js'

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

/** How the page reaches the process that runs the loops. */
export interface ProjectControl {
  /** A root was just registered: start its loop. */
  addProject(root: string): void
  /**
   * The operator confirmed a project's forge repository: run its loop with it
   * from now on. Only called while that loop has no work in flight.
   */
  setProjectForge?(root: string, pushUrl: string): void
  /** A root was just unregistered: stop and forget its loop. */
  removeProject(root: string): void
  /** Today's spend across every loop, and the shared cap when one applies. */
  spend(now: number): { readonly costUsdDay: number, readonly cap: number | null }
}

/** What the page can do. Each one is a CLI verb of the same name. */
export type DashboardVerb = 'answer' | 'resume' | 'pause'

export interface DashboardDeps {
  readonly ownRoot: string
  readonly home: string
  /** Whether this process is ticking a loop for that project right now. */
  readonly presence: (root: string, own: boolean) => LoopPresence
  /** Present where the process can run projects besides its own root. */
  readonly control?: ProjectControl
  /** The one directory the add-project picker may list below; absent, it lists nothing. */
  readonly browseRoot?: string
  readonly requestRejection: (request: { readonly headers: IncomingHttpHeaders }) => 401 | 403 | undefined
  readonly assets: DashboardAssets
  readonly now?: () => number
  /**
   * Told after a write succeeds, so the process running that project's loop
   * can act at once: abandon the dispatch in flight on a pause, tick on the
   * rest. A project run by another process notices on its own next tick.
   */
  readonly onOperatorAction?: (project: Project, verb: DashboardVerb) => void
  /** The forge merges: a finished goal's release pull request must merge before the next goal starts. */
  readonly forgeMerges?: boolean
  /** Where failures the page only sees as a short refusal are recorded in full. */
  readonly logError?: (message: string, error: unknown) => void
}

export interface DashboardAssets {
  readonly html: string
  readonly js: string
  /** The page's strings in each language; loaded before `js`. */
  readonly i18n: string
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
  /** The goal is done: a halt that is the loop finishing, not failing. */
  readonly completed: boolean
  readonly haltReasons: readonly string[]
  /** The same reasons as codes and values, for the page to say in its reader's language. */
  readonly haltDetails: readonly HaltDetail[]
  readonly question: string | null
  readonly taskCounts: Readonly<Record<string, number>>
  readonly costUsdSession: number | null
  readonly costUsdDay: number | null
  readonly updatedAt: string | null
  /** Why the page could not read this project; the rest is then null. */
  readonly error: string | null
  /** The home page's column for it, and since when. */
  readonly lane: AttentionLane
  readonly since: string | null
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
  /** For a project not yet started: whether starting it would be refused, and why. */
  readonly readiness: Readiness | null
  /** pilot's planning documents in the repository, readable before and after a start. */
  readonly documents: readonly PlanningDocument[]
  readonly docsDir: string | null
  /** The planner's and the reviewer's last notes, kept under `.devloop/`. */
  readonly planNote: string | null
  readonly reviewNote: string | null
  /** The newest pre-PR checks and review verdicts, for judging the PR budget trial. */
  readonly prLog: readonly PrLogEntry[]
  /** Which of the project's goals is current; 1 until a finished goal hands over. */
  readonly goalNumber: number
  /** The current goal's release pull request, when the forge merges. */
  readonly release: Release | null
}

export type TaskView = Pick<Task,
  'id' | 'title' | 'tier' | 'status' | 'risk' | 'attempts' | 'reviewCycles'
  | 'allowedPaths' | 'acceptance' | 'lastReviewVerdict' | 'planner' | 'implementer' | 'reviewer'>

export interface EventView {
  readonly revision: number | null
  readonly at: string | null
  readonly action: string | null
}

const GOAL_MAX_BYTES = 64 * 1024
const PROGRESS_MAX_BYTES = 64 * 1024
const NOTE_MAX_BYTES = 64 * 1024
const PR_LOG_SHOWN = 50
/** A record carries a whole state snapshot, so the tail is read in bytes, not lines. */
const EVENTS_TAIL_BYTES = 512 * 1024
const EVENTS_SHOWN = 40

export async function summarizeProject(project: Project, deps: Pick<DashboardDeps, 'presence'>, now: number): Promise<ProjectSummary> {
  return (await readProject(project, deps, now, false)).summary
}

export async function describeProject(project: Project, deps: Pick<DashboardDeps, 'presence'>, now: number): Promise<ProjectDetail> {
  const { summary, extra } = await readProject(project, deps, now, true)
  const detail = { ...summary, ...(extra ?? emptyDetail()) }
  if (summary.error !== null) return detail
  const docs = await readPlanningDocuments(project.root).catch(() => null)
  const withDocs = { ...detail, documents: docs?.documents ?? [], docsDir: docs?.docsDir ?? null }
  // A finished goal gets the start checks again: the next goal on it starts only when they pass.
  if (summary.armed && !summary.completed) return withDocs
  return { ...withDocs, readiness: await inspectReadiness(project.root).catch(() => null) }
}

async function readProject(
  project: Project,
  deps: Pick<DashboardDeps, 'presence'>,
  now: number,
  full: boolean,
): Promise<{ summary: ProjectSummary, extra: Omit<ProjectDetail, keyof ProjectSummary> | null }> {
  const loop: LoopPresence = deps.presence(project.root, project.own)
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
    completed: false,
    haltReasons: [],
    haltDetails: [],
    question: null,
    taskCounts: {},
    costUsdSession: null,
    costUsdDay: null,
    updatedAt: null,
    error: null,
    lane: 'idle',
    since: null,
  }
  const placed = (summary: ProjectSummary, state: LoopState | null, holdReason: string | null = null): ProjectSummary => ({
    ...summary,
    ...attentionFor({ ...summary, error: summary.error !== null, state, holdReason }),
  })

  try {
    await lstat(project.root)
  } catch {
    return { summary: placed({ ...blank, error: 'directory not found' }, null), extra: null }
  }
  // Everything below reads inside `.devloop/`, and only once `workspaceArmed`
  // has refused a symlinked directory or GOAL.md: a registered project must not
  // be a way to serve a file from somewhere else.
  if (!await workspaceArmed(project.root)) return { summary: placed(blank, null), extra: null }

  try {
    const state = await loadState(project.root, now)
    const budget = await effectiveBudget(project.root)
    const diagnosis = diagnoseHalt(state, budget.limits, now)
    const gate = gateFor(state, budget.limits, now)
    const summary: ProjectSummary = placed({
      ...blank,
      armed: true,
      revision: state.revision,
      lastAction: actionKey(state.lastAction),
      halted: diagnosis.halted,
      paused: state.paused !== undefined,
      completed: state.goalCompleted,
      haltReasons: diagnosis.reasons,
      haltDetails: diagnosis.details,
      question: gate?.question ?? null,
      taskCounts: countByStatus(state.tasks),
      costUsdSession: state.usage.costUsdSession,
      costUsdDay: state.usage.costUsdDay,
      updatedAt: state.updatedAt,
    }, state, gate?.reason ?? null)
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
        readiness: null,
        documents: [],
        docsDir: null,
        planNote: await readHead(join(devloopDir(project.root), 'PLAN.md'), NOTE_MAX_BYTES),
        reviewNote: await readHead(join(devloopDir(project.root), 'REVIEW.md'), NOTE_MAX_BYTES),
        prLog: await readPrLog(project.root, PR_LOG_SHOWN),
        goalNumber: goalNumber(state),
        release: state.release ?? null,
      },
    }
  } catch (error) {
    return { summary: placed({ ...blank, armed: true, error: messageOf(error) }, null), extra: null }
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
    readiness: null,
    documents: [],
    docsDir: null,
    planNote: null,
    reviewNote: null,
    prLog: [],
    goalNumber: 1,
    release: null,
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
    ...(task.planner === undefined ? {} : { planner: task.planner }),
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
  let ownIsRepository: Promise<boolean> | null = null
  const ownListed = async (summary: ProjectSummary): Promise<boolean> => {
    if (summary.armed) return true
    // An unarmed own root that is not a repository — `$HOME`, when launchd
    // starts DSH there — can never become a project, and is only noise.
    ownIsRepository ??= validateProjectRoot(summary.root).then(() => true, () => false)
    return ownIsRepository
  }

  return async (req, res) => {
    const rejection = deps.requestRejection(req)
    if (rejection === 403) return send(res, req, 403, 'text/plain; charset=utf-8', 'forbidden\n')
    if (rejection === 401) return send(res, req, 401, 'text/html; charset=utf-8', LOGIN_HINT)

    const url = new URL(req.url ?? '/', 'http://dashboard.invalid')
    const path = url.pathname
    const action = ACTION_ROUTE.exec(path)
    if (action) {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return send(res, req, 405, 'text/plain; charset=utf-8', 'method not allowed\n')
      }
      const verb = action[2] as DashboardVerb | ProjectVerb
      if (verb === 'cleanup') return cleanup(req, res, deps, action[1] as string)
      if (verb === 'start' || verb === 'next' || verb === 'unregister') return manage(req, res, deps, action[1] as string, verb)
      return act(req, res, deps, now, action[1] as string, verb)
    }
    if (path === `${DASHBOARD_PATH}/api/projects` && req.method === 'POST') return register(req, res, deps)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', path === `${DASHBOARD_PATH}/api/projects` ? 'GET, HEAD, POST' : 'GET, HEAD')
      return send(res, req, 405, 'text/plain; charset=utf-8', 'method not allowed\n')
    }

    if (path === DASHBOARD_PATH) {
      res.writeHead(308, { ...COMMON_HEADERS, location: `${DASHBOARD_PATH}/` })
      res.end()
      return
    }
    if (path === `${DASHBOARD_PATH}/`) return send(res, req, 200, 'text/html; charset=utf-8', deps.assets.html)
    if (path === `${DASHBOARD_PATH}/app.js`) return send(res, req, 200, 'text/javascript; charset=utf-8', deps.assets.js)
    if (path === `${DASHBOARD_PATH}/i18n.js`) return send(res, req, 200, 'text/javascript; charset=utf-8', deps.assets.i18n)
    if (path === `${DASHBOARD_PATH}/app.css`) return send(res, req, 200, 'text/css; charset=utf-8', deps.assets.css)

    try {
      if (path === `${DASHBOARD_PATH}/api/projects`) {
        const list = await listProjects(deps.ownRoot, deps.home)
        const summaries = await Promise.all(list.projects.map(project => summarizeProject(project, deps, now())))
        const projects: ProjectSummary[] = []
        for (const summary of summaries) if (!summary.own || await ownListed(summary)) projects.push(summary)
        const global = deps.control?.spend(now()) ?? null
        return json(res, req, 200, { ok: true, value: { projects, registryError: list.registryError, global } })
      }
      if (path === `${DASHBOARD_PATH}/api/browse`) return browse(req, res, deps, url.searchParams.get('path') ?? '')
      const prefix = `${DASHBOARD_PATH}/api/projects/`
      if (path.startsWith(prefix)) {
        const segments = path.slice(prefix.length).split('/')
        const [id = '', view] = segments
        if (segments.length > 2 || (view !== undefined && view !== 'status')) return send(res, req, 404, 'text/plain; charset=utf-8', 'not found\n')
        const project = findProject(await listProjects(deps.ownRoot, deps.home), id)
        if (!project) return json(res, req, 404, { ok: false, error: { code: 'not-found', message: 'no such project' } })
        if (view === 'status') {
          // Moved or deleted since registration, or STATE unreadable: say so without git's
          // stderr or paths, and keep the full error in the log.
          try {
            return json(res, req, 200, { ok: true, value: await statusView(project.root) })
          } catch (error) {
            deps.logError?.('[dsh-devloop] repository status failed', error)
            return json(res, req, 422, { ok: false, error: refusalFor(error) })
          }
        }
        return json(res, req, 200, { ok: true, value: await describeProject(project, deps, now()) })
      }
    } catch (error) {
      return json(res, req, 500, { ok: false, error: { code: 'internal', message: messageOf(error) } })
    }
    return send(res, req, 404, 'text/plain; charset=utf-8', 'not found\n')
  }
}

/** What the page can do to the set of projects, as opposed to one loop's state. */
export type ProjectVerb = 'start' | 'next' | 'unregister' | 'cleanup'

const ACTION_ROUTE = new RegExp(`^${DASHBOARD_PATH}/api/projects/([0-9a-f]{12})/(answer|resume|pause|start|next|unregister|cleanup)$`)
const MAX_BODY_BYTES = 4 * 1024
/** A goal is the one body that carries prose. */
const MAX_GOAL_BODY_BYTES = MAX_GOAL_BYTES + 4 * 1024
const ANSWERS = new Set<GateOption['key']>(['retry', 'review', 'accept', 'stop'])

const FAILURE_STATUS: Readonly<Record<OperatorFailure, number>> = {
  stale: 409,
  busy: 503,
  refused: 422,
}

type Fail = (status: number, code: string, message: string) => void

/** Parse a write's body, refusing anything a cross-site form could have sent. */
async function writeBody(req: IncomingMessage, fail: Fail, max = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  // Defence in depth beside DSH's Origin check: a cross-site form cannot send
  // this content type without a preflight the page never answers.
  const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json') {
    fail(415, 'bad-request', 'send application/json')
    return null
  }
  try {
    return await readJsonBody(req, max)
  } catch (error) {
    fail(400, 'bad-request', messageOf(error))
    return null
  }
}

async function act(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardDeps,
  now: () => number,
  id: string,
  verb: DashboardVerb,
): Promise<void> {
  const fail: Fail = (status, code, message) => json(res, req, status, { ok: false, error: { code, message } })
  const body = await writeBody(req, fail)
  if (body === null) return
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

/** One level of the picker: directories under `browseRoot`, repositories marked. */
async function browse(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps, relative: string): Promise<void> {
  const fail: Fail = (status, code, message) => json(res, req, status, { ok: false, error: { code, message } })
  if (!deps.control || deps.browseRoot === undefined) return fail(501, 'unsupported', 'this process cannot add projects')
  const segments = relative.split('/').filter(segment => segment !== '')
  try {
    const listing = await browseDirectory(deps.browseRoot, segments)
    const listed = new Set((await listProjects(deps.ownRoot, deps.home)).projects.map(project => project.root))
    const entries = listing.entries.map(entry => ({ ...entry, registered: listed.has(entry.root) }))
    return json(res, req, 200, { ok: true, value: { ...listing, entries } })
  } catch (error) {
    if (error instanceof ProjectError) return fail(422, 'refused', error.message)
    return fail(500, 'internal', messageOf(error))
  }
}

/** Delete the confirmed branches that the cleanup plan still offers; `git branch -d` only. */
async function cleanup(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps, id: string): Promise<void> {
  const fail: Fail = (status, code, message) => json(res, req, status, { ok: false, error: { code, message } })
  const body = await writeBody(req, fail)
  if (body === null) return
  const confirmed = confirmedBranches(body)
  if (typeof confirmed === 'string') return fail(400, 'bad-request', confirmed)
  const project = findProject(await listProjects(deps.ownRoot, deps.home), id)
  if (!project) return fail(404, 'not-found', 'no such project')
  try {
    const result = await runCleanup(project.root, confirmed)
    if (result === 'busy') return fail(503, 'busy', 'the loop holds this project\'s lock; try again in a moment')
    return json(res, req, 200, { ok: true, value: result })
  } catch (error) {
    deps.logError?.('[dsh-devloop] cleanup failed', error)
    return json(res, req, 422, { ok: false, error: refusalFor(error) })
  }
}

function refusalFor(error: unknown): { code: string, message: string } {
  return error instanceof UnreadableStateError
    ? { code: 'refused', message: 'this project\'s STATE cannot be read, so its task branches are unknown; repair it first' }
    : { code: 'refused', message: 'could not read this repository\'s branches' }
}

/** Register a repository. Its loop starts at once and idles until it is armed. */
async function register(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps): Promise<void> {
  const fail: Fail = (status, code, message) => json(res, req, status, { ok: false, error: { code, message } })
  if (!deps.control) return fail(501, 'unsupported', 'this process cannot run other projects')
  const body = await writeBody(req, fail)
  if (body === null) return
  if (typeof body.root !== 'string') return fail(400, 'bad-request', 'root must be an absolute path')
  try {
    const real = await registerProject(deps.home, deps.ownRoot, body.root)
    deps.control.addProject(real)
    return json(res, req, 200, { ok: true, value: { id: projectId(real), root: real } })
  } catch (error) {
    if (error instanceof ProjectError) return fail(422, 'refused', error.message)
    return fail(500, 'internal', messageOf(error))
  }
}

async function manage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardDeps,
  id: string,
  verb: ProjectVerb,
): Promise<void> {
  const fail: Fail = (status, code, message) => json(res, req, status, { ok: false, error: { code, message } })
  const body = await writeBody(req, fail, verb === 'start' || verb === 'next' ? MAX_GOAL_BODY_BYTES : MAX_BODY_BYTES)
  if (body === null) return
  const project = findProject(await listProjects(deps.ownRoot, deps.home), id)
  if (!project) return fail(404, 'not-found', 'no such project')
  try {
    if (verb === 'start') {
      if (typeof body.goal !== 'string') return fail(400, 'bad-request', 'goal must be text')
      // Checked here, not only on the page: each of these would otherwise be
      // found at the first merge, after plan, delegate and review were paid for.
      const readiness = await inspectReadiness(project.root).catch(() => null)
      if (readiness === null) return fail(422, 'not-ready', '读不到这个仓库的 git 状态，没有启动。')
      const refusal = readinessRefusal(readiness)
      if (refusal !== null) return fail(422, 'not-ready', refusal)
      await armProject(project.root, body.goal)
      // The loop was already ticking, idle for want of a goal; wake it rather
      // than leave the operator watching a page that has not changed yet.
      deps.onOperatorAction?.(project, 'resume')
      return json(res, req, 200, { ok: true, value: { id: project.id } })
    }
    if (verb === 'next') {
      if (typeof body.goal !== 'string') return fail(400, 'bad-request', 'goal must be text')
      const revision = body.revision
      if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
        return fail(400, 'bad-request', 'revision is required: the state you were looking at')
      }
      // The same checks as a first start: a next goal pays for plan, delegate and review too.
      const readiness = await inspectReadiness(project.root).catch(() => null)
      if (readiness === null) return fail(422, 'not-ready', '读不到这个仓库的 git 状态，没有启动。')
      const refusal = readinessRefusal(readiness)
      if (refusal !== null) return fail(422, 'not-ready', refusal)
      const saved = await startNextGoal(project.root, body.goal, { expectedRevision: revision, requireRelease: deps.forgeMerges === true, via: 'dashboard' })
      deps.onOperatorAction?.(project, 'resume')
      return json(res, req, 200, { ok: true, value: { id: project.id, revision: saved.revision, goal: goalNumber(saved) } })
    }
    if (project.own) return fail(422, 'refused', 'this process\'s own root cannot be removed')
    if (!deps.control) return fail(501, 'unsupported', 'this process cannot run other projects')
    const summary = await summarizeProject(project, deps, Date.now())
    if (summary.armed && !summary.halted) {
      // Removing a running loop would abandon its dispatch mid-flight with no
      // record of why. Pausing first puts that decision in its journal.
      return fail(422, 'refused', 'pause this loop before removing it')
    }
    deps.control.removeProject(project.root)
    await unregisterProject(deps.home, project.root)
    return json(res, req, 200, { ok: true, value: { id: project.id } })
  } catch (error) {
    if (error instanceof ProjectError) return fail(422, 'refused', error.message)
    if (error instanceof OperatorError) return fail(FAILURE_STATUS[error.code], error.code, error.message)
    return fail(500, 'internal', messageOf(error))
  }
}

async function readJsonBody(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > max) throw new Error(`body over ${max} bytes`)
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
  const [html, js, i18n, css, version] = await Promise.all([
    readFile(join(dir, 'index.html'), 'utf8'),
    readFile(join(dir, 'app.js'), 'utf8'),
    readFile(join(dir, 'i18n.js'), 'utf8'),
    readFile(join(dir, 'app.css'), 'utf8'),
    packageVersion(join(dir, '..', 'package.json')),
  ])
  // Stamped once at load, so the page names the release that is actually
  // installed — the one `dsh plugin add` put there — without another request.
  return { html: html.replaceAll(VERSION_PLACEHOLDER, escapeHtml(version)), js, i18n, css }
}

const VERSION_PLACEHOLDER = '%DEVLOOP_VERSION%'

async function packageVersion(file: string): Promise<string> {
  try {
    const value = (JSON.parse(await readFile(file, 'utf8')) as { version?: unknown }).version
    return typeof value === 'string' && /^\d+\.\d+\.\d+[\w.+-]*$/.test(value) ? `v${value}` : 'v?'
  } catch {
    return 'v?'
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
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
            logError: (message, error) => inner.logger.error(message, error),
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
