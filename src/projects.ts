import { createHash } from 'node:crypto'
import { constants, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { parseRemoteUrl } from './forge.js'
import { hostGit } from './worktree.js'

/**
 * The projects an operator has asked the dashboard to show.
 *
 * One project is one requirement: a git repository whose `.devloop/GOAL.md`
 * a loop works toward. The process's own `root` is always one of them; the rest
 * come from a registry the operator owns, at `$DSH_HOME/devloop/projects.json`:
 *
 * ```json
 * { "projects": [{ "root": "/Users/me/Dev/app" }] }
 * ```
 *
 * The registry is per operator rather than per project because it answers "which
 * directories may this machine's dashboard read", which is not a question any
 * one repository can answer about itself.
 */
export interface Project {
  /** Opaque, stable handle. The page names projects by this, never by path. */
  readonly id: string
  readonly root: string
  readonly name: string
  /** The directory this process runs a loop for. */
  readonly own: boolean
  /**
   * The forge repository its task pull requests go to, as the operator
   * confirmed it and the registry keeps it; never re-read from the checkout,
   * whose remotes can be rewritten. Null when none has been confirmed.
   */
  readonly pushUrl: string | null
}

export interface ProjectList {
  readonly projects: readonly Project[]
  /** Why part of the registry was ignored; null when it read cleanly or is absent. */
  readonly registryError: string | null
}

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

export function registryPath(home: string): string {
  return join(home, 'devloop', 'projects.json')
}

/**
 * A handle derived from the realpath, so two spellings of one directory are one
 * project, and so the page never has to put a path in a URL. A request can then
 * only ever name a project already listed: there is no string to traverse with.
 */
export function projectId(realRoot: string): string {
  return createHash('sha256').update(realRoot).digest('hex').slice(0, 12)
}

export async function listProjects(ownRoot: string, home: string): Promise<ProjectList> {
  const projects: Project[] = []
  const seen = new Set<string>()
  const add = async (root: string, own: boolean, pushUrl: string | null): Promise<void> => {
    const real = await canonical(root)
    if (seen.has(real)) return
    seen.add(real)
    projects.push({ id: projectId(real), root: real, name: basename(real) || real, own, pushUrl })
  }

  await add(ownRoot, true, null)
  const registry = await readRegistry(registryPath(home))
  for (const { root, pushUrl } of registry.roots) await add(root, false, pushUrl)
  return { projects, registryError: registry.error }
}

export function findProject(list: ProjectList, id: string): Project | undefined {
  return list.projects.find(project => project.id === id)
}

/**
 * A missing directory still resolves to a stable id: a project whose checkout
 * was moved should show as missing, not vanish from the list.
 */
async function canonical(root: string): Promise<string> {
  try {
    return await realpath(root)
  } catch {
    return resolve(root)
  }
}

async function readRegistry(file: string): Promise<{ roots: { root: string, pushUrl: string | null }[], error: string | null }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [], error: null }
    return { roots: [], error: `${file}: ${(error as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { roots: [], error: `${file} is not valid JSON` }
  }
  const list = typeof parsed === 'object' && parsed !== null
    ? (parsed as { projects?: unknown }).projects
    : undefined
  if (!Array.isArray(list)) return { roots: [], error: `${file} needs a "projects" array` }

  const roots: { root: string, pushUrl: string | null }[] = []
  const rejected: number[] = []
  const badUrls: number[] = []
  list.forEach((entry: unknown, index) => {
    const record = typeof entry === 'object' && entry !== null ? entry as { root?: unknown, pushUrl?: unknown } : {}
    // Relative paths would resolve against whatever directory DSH was started
    // in, which is not something the file's author chose.
    if (!(typeof record.root === 'string' && isAbsolute(record.root))) {
      rejected.push(index)
      return
    }
    // A forge URL that does not parse is dropped, not guessed at: the project then has none confirmed.
    const pushUrl = record.pushUrl === undefined ? null : validPushUrl(record.pushUrl)
    if (record.pushUrl !== undefined && pushUrl === null) badUrls.push(index)
    roots.push({ root: record.root, pushUrl })
  })
  const problems = [
    ...(rejected.length === 0 ? [] : [`entries ${rejected.join(', ')} ignored; each needs an absolute "root"`]),
    ...(badUrls.length === 0 ? [] : [`entries ${badUrls.join(', ')}: "pushUrl" is not a forge URL and was ignored`]),
  ]
  return { roots, error: problems.length === 0 ? null : `${file}: ${problems.join('; ')}` }
}

// ---- writes -----------------------------------------------------------------
//
// Registering a project is choosing a directory where agents will run and
// commit. So a root must be an existing git toplevel — the worktree code refuses
// anything else, and refusing it here says so before a loop is started for it —
// and it is recorded by realpath, so a symlink cannot later be repointed under
// an entry the operator already approved.

export class ProjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}

/** Resolve and check a candidate root. Returns its realpath. */
export async function validateProjectRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new ProjectError('root must be an absolute path')
  let real: string
  try {
    real = await realpath(root)
  } catch {
    throw new ProjectError(`${root} does not exist`)
  }
  const meta = await stat(real)
  if (!meta.isDirectory()) throw new ProjectError(`${real} is not a directory`)
  let toplevel: string
  try {
    // An inherited GIT_WORK_TREE would otherwise name a toplevel that is not this folder's.
    toplevel = await realpath((await hostGit(real, ['rev-parse', '--show-toplevel'], { timeoutMs: 5_000 })).trim())
  } catch {
    throw new ProjectError(`${real} is not a git repository`)
  }
  if (toplevel !== real) throw new ProjectError(`${real} is inside ${toplevel}; register the repository's top level`)
  try {
    const loop = await lstat(join(real, DEVLOOP_DIR_NAME))
    if (loop.isSymbolicLink() || !loop.isDirectory()) throw new ProjectError(`${real}/.devloop must be a real directory`)
  } catch (error) {
    if (error instanceof ProjectError) throw error
    // Absent is fine: arming creates it.
  }
  return real
}

const DEVLOOP_DIR_NAME = '.devloop'
const GOAL_FILE_NAME = 'GOAL.md'
export const MAX_GOAL_BYTES = 64 * 1024

/**
 * Rewrite the registry with `change` applied to its roots. Refuses a registry it
 * cannot parse rather than overwriting what the operator wrote by hand; keeps
 * any fields it does not know about on the entries it leaves alone.
 */
async function rewriteRegistry(home: string, change: (entries: RegistryEntry[]) => RegistryEntry[]): Promise<void> {
  const file = registryPath(home)
  let entries: RegistryEntry[] = []
  let text: string | null = null
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (text !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ProjectError(`${file} is not valid JSON; fix it by hand before changing projects here`)
    }
    const list = typeof parsed === 'object' && parsed !== null ? (parsed as { projects?: unknown }).projects : undefined
    if (!Array.isArray(list)) throw new ProjectError(`${file} needs a "projects" array; fix it by hand first`)
    entries = list as RegistryEntry[]
  }
  const next = change(entries)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify({ projects: next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
}

interface RegistryEntry {
  readonly root?: unknown
  readonly [key: string]: unknown
}

/** Serialise registry writes within this process; the file has no lock of its own. */
let registryQueue: Promise<unknown> = Promise.resolve()
function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = registryQueue.then(work, work)
  registryQueue = run.catch(() => undefined)
  return run
}

export async function registerProject(home: string, ownRoot: string, root: string): Promise<string> {
  const real = await validateProjectRoot(root)
  if (real === await canonical(ownRoot)) throw new ProjectError('that is this process\'s own root; it is always listed')
  return serially(async () => {
    await rewriteRegistry(home, (entries) => {
      if (entries.some(entry => typeof entry.root === 'string' && entry.root === real)) {
        throw new ProjectError(`${real} is already registered`)
      }
      return [...entries, { root: real, addedAt: new Date().toISOString() }]
    })
    return real
  })
}

/**
 * Record the forge repository the operator confirmed for a registered
 * project. Refuses a URL the forge could not use and a project not in the
 * registry (the own root takes the profile's `forge.pushUrl`).
 */
export async function setProjectPushUrl(home: string, realRoot: string, pushUrl: string): Promise<void> {
  const url = validPushUrl(pushUrl)
  if (url === null) throw new ProjectError('that is not a forge URL DevLoop can push to (https://host/owner/name or git@host:owner/name)')
  await serially(() => rewriteRegistry(home, (entries) => {
    if (!entries.some(entry => entry.root === realRoot)) throw new ProjectError(`${realRoot} is not registered here`)
    return entries.map(entry => entry.root === realRoot ? { ...entry, pushUrl: url } : entry)
  }))
}

/**
 * The checkout's `remote.origin.url` as configured, for the operator to confirm:
 * read with `git config`, which does not apply `insteadOf` rewriting, and only
 * returned when the forge could use it. Null when there is none.
 */
export async function readOriginUrl(realRoot: string): Promise<string | null> {
  const raw = await hostGit(realRoot, ['config', '--get', 'remote.origin.url'], { timeoutMs: 5_000 }).catch(() => '')
  return validPushUrl(raw.trim())
}

function validPushUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) return null
  try {
    parseRemoteUrl(value)
    return value
  } catch {
    return null
  }
}

/** Forget a project. Its files — `.devloop/`, worktrees, branches — are left exactly as they are. */
export async function unregisterProject(home: string, realRoot: string): Promise<void> {
  await serially(() => rewriteRegistry(home, entries => entries.filter((entry) => {
    return typeof entry.root !== 'string' || entry.root !== realRoot
  })))
  // Entries may have been written by hand with another spelling of the path;
  // the filter above only removes the spelling this page wrote.
  for (const { root } of (await readRegistry(registryPath(home))).roots) {
    if (await canonical(root) === realRoot) {
      throw new ProjectError('the registry still names this project under another spelling; remove it by hand')
    }
  }
}

// ---- browsing ---------------------------------------------------------------
//
// So the page can offer "pick a repository" instead of "type a path". It lists
// directories only, one level at a time, and only under one root the operator
// chose for this machine — `$DEVLOOP_BROWSE_ROOT`, else `~/Dev`. A request names
// a place by path segments relative to that root, and whatever they resolve to,
// symlinks included, must still be inside it.

export function browseRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DEVLOOP_BROWSE_ROOT
  return configured !== undefined && configured !== '' ? configured : join(homedir(), 'Dev')
}

export interface BrowseEntry {
  readonly name: string
  /** Realpath of the directory; what the page registers when it is a repository. */
  readonly root: string
  /** Has a `.git`: a candidate project rather than a folder to open. */
  readonly repo: boolean
}

export interface BrowseListing {
  readonly root: string
  /** Segments below `root`; empty at the top. */
  readonly path: readonly string[]
  readonly entries: readonly BrowseEntry[]
  /** More directories than were listed. */
  readonly truncated: boolean
}

const BROWSE_MAX_ENTRIES = 500
const BROWSE_MAX_DEPTH = 8

export async function browseDirectory(top: string, path: readonly string[]): Promise<BrowseListing> {
  if (path.length > BROWSE_MAX_DEPTH) throw new ProjectError('too deep')
  for (const segment of path) {
    if (segment === '' || segment.startsWith('.') || /[/\\\0]/.test(segment)) throw new ProjectError('bad path segment')
  }
  let base: string
  try {
    base = await realpath(top)
  } catch {
    throw new ProjectError(`${top} does not exist; set DEVLOOP_BROWSE_ROOT`)
  }
  const inside = (real: string): boolean => real === base || real.startsWith(base + sep)
  let dir: string
  try {
    dir = await realpath(join(base, ...path))
  } catch {
    throw new ProjectError('no such directory')
  }
  if (!inside(dir) || !(await stat(dir)).isDirectory()) throw new ProjectError('no such directory')

  const entries: BrowseEntry[] = []
  let truncated = false
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  for (const name of names) {
    if (entries.length >= BROWSE_MAX_ENTRIES) {
      truncated = true
      break
    }
    let real: string
    try {
      real = await realpath(join(dir, name))
      if (!inside(real) || !(await stat(real)).isDirectory()) continue
    } catch {
      continue
    }
    entries.push({ name, root: real, repo: await exists(join(real, '.git')) })
  }
  return { root: base, path: [...path], entries, truncated }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Arm a project: create `.devloop/GOAL.md`. This is what starts its loop — the
 * loop idles until the file exists, as it always has.
 *
 * Never overwrites. A goal changed under a running loop would leave it working
 * through tasks planned for a different one, so an existing goal is edited by
 * hand, deliberately, rather than replaced from a browser.
 */
export async function armProject(realRoot: string, goal: string): Promise<void> {
  await validateProjectRoot(realRoot)
  const text = goal.trim()
  if (text === '') throw new ProjectError('the goal is empty')
  if (Buffer.byteLength(text) > MAX_GOAL_BYTES) throw new ProjectError(`the goal is over ${MAX_GOAL_BYTES} bytes`)
  const dir = join(realRoot, DEVLOOP_DIR_NAME)
  try {
    await mkdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const meta = await lstat(dir)
  if (meta.isSymbolicLink() || !meta.isDirectory()) throw new ProjectError('.devloop must be a real directory')
  let handle
  try {
    handle = await open(
      join(dir, GOAL_FILE_NAME),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ProjectError('this project already has a GOAL.md; edit it by hand to change the goal')
    }
    throw error
  }
  try {
    await handle.writeFile(`${text}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}
