import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import { headlessPrompt } from './dsh.js'
import { parseDevloopResult, validateDevloopResult } from './result.js'

export interface HarnessParentHandle {
  readonly agent: unknown
  dispose(): Promise<void>
}

export interface HarnessRunResult {
  readonly output: readonly unknown[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: string
}

export interface HarnessRunHandle {
  readonly result: Promise<HarnessRunResult>
  dispose(): Promise<void>
}

/** Small structural port around Harness services; keeps prerelease packages optional. */
export interface HarnessHost {
  hasProvider(name: string): boolean
  createParent(cwd: string, signal?: AbortSignal): Promise<HarnessParentHandle>
  start(name: string, parent: unknown, prompt: string, signal: AbortSignal): Promise<HarnessRunHandle>
}

/**
 * Named-provider backend over Harness `ctx.subagents`. A temporary, idle root
 * Agent supplies the exact task worktree cwd required by native providers.
 * Both the child run and parent handle are holder-owned and disposed on every
 * success, failure, and cancellation path.
 */
export class HarnessSubagentBackend implements AgentBackend {
  constructor(private readonly host: HarnessHost) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const provider = input.route?.backend.startsWith('subagent:')
      ? input.route.backend.slice('subagent:'.length)
      : undefined
    if (!provider) return { status: 'failed', detail: 'Harness route backend must be subagent:<provider>' }
    if (!this.host.hasProvider(provider)) {
      return { status: 'failed', detail: `no Harness subagent provider registered for ${provider}` }
    }
    const cwd = input.worktreeRoot ?? input.workspaceRoot
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (input.signal?.aborted) controller.abort()
    else input.signal?.addEventListener('abort', onAbort, { once: true })
    let parent: HarnessParentHandle | undefined
    let run: HarnessRunHandle | undefined
    try {
      parent = await this.host.createParent(cwd, controller.signal)
      run = await this.host.start(provider, parent.agent, headlessPrompt(input), controller.signal)
      const result = await run.result
      if (result.stopReason !== 'completed') {
        return {
          status: 'failed',
          detail: result.diagnostic ?? `Harness subagent stopped: ${result.stopReason}`,
        }
      }
      const outcome = result.structured === undefined
        ? parseDevloopResult(textOutput(result.output))
        : validateDevloopResult(result.structured)
      return { status: 'started', outcome, agent: `subagent:${provider}` }
    } catch (error) {
      return { status: 'failed', detail: error instanceof Error ? error.message : 'Harness subagent failed' }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      await run?.dispose().catch(() => undefined)
      await parent?.dispose().catch(() => undefined)
    }
  }

  async cancel(_taskId: string): Promise<void> {}

  async health(): Promise<'ok' | 'down'> {
    return 'ok'
  }
}

interface AgentRegistryLike {
  create(options: {
    readonly sessionId: string
    readonly meta: { readonly cwd: string }
    readonly signal?: AbortSignal
  }): Promise<HarnessParentHandle>
}

interface SubagentRuntimeLike {
  getProvider(name: string): unknown
  start(name: string, request: {
    readonly parent: unknown
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly signal: AbortSignal
    readonly label?: string
  }): Promise<HarnessRunHandle>
}

/** Runtime adapter for installed Harness services without a hard package dependency. */
export class CordisHarnessHost implements HarnessHost {
  constructor(private readonly ctx: Context) {}

  hasProvider(name: string): boolean {
    return this.subagents()?.getProvider(name) !== undefined
  }

  async createParent(cwd: string, signal?: AbortSignal): Promise<HarnessParentHandle> {
    const agents = this.service<AgentRegistryLike>('agents')
    if (!agents) throw new Error('Harness agents service is not installed')
    return agents.create({
      sessionId: `devloop-${randomUUID()}`,
      meta: { cwd },
      ...(signal === undefined ? {} : { signal }),
    })
  }

  start(name: string, parent: unknown, prompt: string, signal: AbortSignal): Promise<HarnessRunHandle> {
    const subagents = this.subagents()
    if (!subagents) throw new Error('Harness subagents service is not installed')
    return subagents.start(name, {
      parent,
      prompt: [{ type: 'text', text: prompt }],
      signal,
      label: 'DevLoop',
    })
  }

  private subagents(): SubagentRuntimeLike | undefined {
    return this.service<SubagentRuntimeLike>('subagents')
  }

  private service<T>(name: string): T | undefined {
    const context = this.ctx as unknown as { get(name: string): unknown }
    return context.get(name) as T | undefined
  }
}

function textOutput(blocks: readonly unknown[]): string {
  return blocks.flatMap(block => {
    if (typeof block !== 'object' || block === null) return []
    const value = block as { type?: unknown; text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n')
}
