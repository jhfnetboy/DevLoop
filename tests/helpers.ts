import type { LoopState, Task, TaskStatus } from '../src/types.ts'
import { emptyUsage } from '../src/budget.ts'
import { emptyState } from '../src/persist.ts'

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

export function setStatus(state: LoopState, id: string, status: TaskStatus): LoopState {
  return {
    ...state,
    tasks: state.tasks.map(task => task.id === id ? { ...task, status } : task),
  }
}

export function baseState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    ...emptyState(0),
    usage: emptyUsage(0),
    ...overrides,
  }
}
