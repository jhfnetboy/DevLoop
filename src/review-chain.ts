import type { AgentBackend, AgentRunInput, AgentRunResult } from './backend.js'
import type { Route } from './types.js'

/**
 * A review in two steps: the local reviewer first, then the forge.
 *
 * The forge's pull request is opened only for a change the local reviewer
 * passed, so PR-daemon's rounds are spent on changes already worth a person's
 * time. A local REWORK, REPLAN or BLOCKED is the verdict, and a local failure
 * is the failure: the forge is not asked, and no pull request is opened for
 * that attempt. Anything but a review goes straight to the forge.
 */
export class LocalThenForgeReview implements AgentBackend {
  constructor(
    private readonly local: AgentBackend,
    private readonly localRoute: Route,
    private readonly forge: AgentBackend,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (input.action.type !== 'review') return this.forge.run(input)
    const first = await this.local.run({ ...input, route: this.localRoute })
    const outcome = first.outcome
    if (first.status !== 'started' || outcome === undefined || outcome.kind !== 'review') return first
    if (outcome.verdict !== 'PASS' && outcome.verdict !== 'PASS_WITH_NOTES') return first
    return this.forge.run(input)
  }

  async cancel(taskId: string): Promise<void> {
    await Promise.all([this.local.cancel(taskId), this.forge.cancel(taskId)])
  }

  async health(): Promise<'ok' | 'down'> {
    const statuses = await Promise.all([this.local.health(), this.forge.health()])
    return statuses.every(status => status === 'ok') ? 'ok' : 'down'
  }
}
