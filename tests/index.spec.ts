import { describe, expect, it } from 'vitest'
import * as pkg from '../src/index.ts'

describe('package entry exports', () => {
  it('keeps the 0.2.2 worktree surface next to 0.2.3 headless', () => {
    expect(typeof pkg.prepareDelegateWorktree).toBe('function')
    expect(typeof pkg.worktreePath).toBe('function')
    expect(typeof pkg.worktreeTaskToken).toBe('function')
    expect(typeof pkg.headlessPrompt).toBe('function')
    expect(pkg.DshHeadlessBackend).toBeTypeOf('function')
    expect(pkg.ClaudeCliBackend).toBeTypeOf('function')
    expect(pkg.CodexCliBackend).toBeTypeOf('function')
  })
})
