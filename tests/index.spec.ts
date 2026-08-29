import { describe, expect, it } from 'vitest'
import * as pkg from '../src/index.ts'

describe('package entry exports', () => {
  it('keeps the 0.2.2 worktree surface next to 0.2.3 headless', () => {
    expect(typeof pkg.prepareDelegateWorktree).toBe('function')
    expect(typeof pkg.preparePlanWorktree).toBe('function')
    expect(typeof pkg.removePlanWorktree).toBe('function')
    expect(pkg.PLAN_WORKTREE_ID).toBe('_loop-plan')
    expect(typeof pkg.worktreePath).toBe('function')
    expect(typeof pkg.planWorktreePath).toBe('function')
    expect(typeof pkg.worktreeTaskToken).toBe('function')
    expect(typeof pkg.headlessPrompt).toBe('function')
    expect(pkg.DshHeadlessBackend).toBeTypeOf('function')
    expect(pkg.ClaudeCliBackend).toBeTypeOf('function')
    expect(pkg.CodexCliBackend).toBeTypeOf('function')
    expect(typeof pkg.commitDirtyTaskWorktree).toBe('function')
  })
})
