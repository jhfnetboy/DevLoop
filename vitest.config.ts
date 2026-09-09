import { defineConfig } from 'vitest/config'

/**
 * Five suites do real git and real process work and dominate the wall clock;
 * measured on an idle machine, in ms:
 *
 *   worktree 230457 · service 143720 · forge 73143 · persist 35196 · e2e 24996
 *   everything else together: under 20000
 *
 * They are IO-bound rather than CPU-bound, so running one per core starves
 * them. Under load the effect is not a failure but an arbitrary slowdown: on a
 * saturated machine a 3ms case in forge.spec took 918724ms, and one worktree
 * case took 7295317ms. A per-test timeout only translates "slow" into "red" at
 * whatever threshold it happens to sit at, which is why it is generous here and
 * why the worker count is capped: a red that means "the machine was busy" gets
 * ignored, and then stops catching regressions too.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Enough parallelism to keep the wall clock sane, few enough that the
    // git-heavy suites are not competing for the same disk and process table.
    maxWorkers: 4,
    minWorkers: 1,
    // Names a slow suite in the output instead of leaving it to be discovered
    // by a timeout.
    slowTestThreshold: 5_000,
  },
})
