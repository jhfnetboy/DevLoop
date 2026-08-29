import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { LoopState, Task, TaskStatus } from '../src/types.ts'
import { emptyUsage } from '../src/budget.ts'
import { emptyState } from '../src/persist.ts'

const execFileAsync = promisify(execFile)

export async function mkdtempInRepo(prefix: string): Promise<string> {
  const base = join(import.meta.dirname, '..', '.tmp')
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, prefix))
}

export async function initGitRepo(root: string): Promise<void> {
  const template = join(root, '.git-template-empty')
  await mkdir(template, { recursive: true })
  await execFileAsync('git', ['init', '-b', 'main', `--template=${template}`], { cwd: root })
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'devloop@test'])
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'devloop'])
  await execFileAsync('git', ['-C', root, 'config', 'commit.gpgsign', 'false'])
  await writeFile(join(root, 'README.md'), '# t\n', 'utf8')
  await execFileAsync('git', ['-C', root, 'add', 'README.md'])
  await execFileAsync('git', ['-C', root, 'commit', '-m', 'init'])
}

export function makeTask(partial: Partial<Task> & Pick<Task, 'id' | 'status'>): Task {
  return {
    title: partial.id,
    tier: 'T1',
    risk: 'low',
    attempts: 0,
    reviewCycles: 0,
    allowedPaths: ['src/**'],
    acceptance: ['tests pass'],
    ...partial,
  }
}

export function withTasks(state: LoopState, tasks: readonly Task[]): LoopState {
  return { ...state, tasks }
}

export function setStatus(state: LoopState, id: string, status: TaskStatus, extra: Partial<Task> = {}): LoopState {
  return {
    ...state,
    tasks: state.tasks.map(task => task.id === id ? { ...task, status, ...extra } : task),
  }
}

export function baseState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    ...emptyState(0),
    usage: emptyUsage(0),
    ...overrides,
  }
}
