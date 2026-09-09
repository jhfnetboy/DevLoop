# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the TypeScript plugin implementation. Keep deterministic state transitions in `loop.ts` and `tick.ts`, persistence in `persist.ts`, model dispatch in `backend.ts`/`dsh.ts`, and Git worktree operations in `worktree.ts`. Public exports are collected in `src/index.ts`. Tests live in `tests/`, with reusable helpers in `tests/helpers.ts` and executable fixtures in `tests/fixtures/`. Operator documentation and architecture decisions belong in `docs/` and `docs/adr/`; `templates/GOAL.md` is shipped to users. `lib/` is generated build output—do not edit it directly.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile` installs the locked dependency set. Use Node `^22.19.0` or `>=24`.
- `pnpm test` runs the full Vitest suite once.
- `pnpm exec vitest tests/budget.spec.ts` runs one test file while iterating.
- `pnpm build` type-checks strict TypeScript and emits JavaScript and declarations into `lib/`.

Run both `pnpm test` and `pnpm build` before opening a pull request. Package installation also invokes the build through `prepare`. A GitHub Actions workflow runs the same two commands on every pull request.

Five suites do real git and real process work and account for nearly all of the wall clock. Measured on an idle machine, in ms: worktree 230457, service 143720, forge 73143, persist 35196, autonomous.e2e 24996; everything else together stays under 20000. They are IO-bound, so `vitest.config.ts` caps the worker count rather than running one per core.

Treat a timeout in those five as a statement about the machine until proven otherwise. On a saturated host a 3ms case in `forge.spec` took 918724ms and one `worktree.spec` case took 7295317ms — the same code and the same tests that pass in milliseconds when the machine is idle. Attribute a failure the way any other regression is attributed: stash the change, re-run on the branch point, and see whether it still fails. A red that means "the machine was busy" gets ignored, and an ignored check stops catching regressions as well.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single quotes, no semicolons, trailing commas in multiline constructs, and explicit types at module boundaries. This is an ESM/NodeNext project; source-to-source imports use `.js` extensions, while tests may import `.ts` files. Use `camelCase` for functions and variables, `PascalCase` for classes and types, and descriptive lowercase filenames. Preserve strict-null and unchecked-index handling rather than bypassing them with broad assertions.

## Testing Guidelines

Vitest discovers `tests/**/*.spec.ts`; name new tests after the module or behavior under test. Prefer deterministic unit tests and explicit state fixtures. Worktree tests must use the temporary-repository helpers and clean up resources in `afterEach`. Add regression coverage for bug fixes, especially around budgets, locks, path validation, state persistence, and merge safety. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use short imperative summaries describing the outcome, for example: `Refuse empty PASS merges and persist a wedged abort.` Keep commits narrowly scoped and include tests with behavioral changes. Pull requests should explain the user-visible effect, affected state transitions or safety invariants, and verification commands. Link relevant issues or ADRs; include configuration examples for operator-facing changes. Screenshots are only necessary when documentation gains a visual artifact.
