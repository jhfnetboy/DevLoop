import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

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
  const add = async (root: string, own: boolean): Promise<void> => {
    const real = await canonical(root)
    if (seen.has(real)) return
    seen.add(real)
    projects.push({ id: projectId(real), root: real, name: basename(real) || real, own })
  }

  await add(ownRoot, true)
  const registry = await readRegistry(registryPath(home))
  for (const root of registry.roots) await add(root, false)
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

async function readRegistry(file: string): Promise<{ roots: string[], error: string | null }> {
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

  const roots: string[] = []
  const rejected: number[] = []
  list.forEach((entry: unknown, index) => {
    const root = typeof entry === 'object' && entry !== null ? (entry as { root?: unknown }).root : undefined
    // Relative paths would resolve against whatever directory DSH was started
    // in, which is not something the file's author chose.
    if (typeof root === 'string' && isAbsolute(root)) roots.push(root)
    else rejected.push(index)
  })
  const error = rejected.length === 0
    ? null
    : `${file}: entries ${rejected.join(', ')} ignored; each needs an absolute "root"`
  return { roots, error }
}
