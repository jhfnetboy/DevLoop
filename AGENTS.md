# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the TypeScript plugin implementation. Keep deterministic state transitions in `loop.ts` and `tick.ts`, persistence in `persist.ts`, model dispatch in `backend.ts`/`dsh.ts`, and Git worktree operations in `worktree.ts`. Public exports are collected in `src/index.ts`. Tests live in `tests/`, with reusable helpers in `tests/helpers.ts` and executable fixtures in `tests/fixtures/`. Operator documentation and architecture decisions belong in `docs/` and `docs/adr/`; `templates/GOAL.md` is shipped to users. `lib/` is generated build output—do not edit it directly.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile` installs the locked dependency set. Use Node `^22.19.0` or `>=24`.
- `pnpm test` runs the full Vitest suite once.
- `pnpm exec vitest tests/budget.spec.ts` runs one test file while iterating.
- `pnpm build` type-checks strict TypeScript and emits JavaScript and declarations into `lib/`.

Run both `pnpm test` and `pnpm build` before opening a pull request. Package installation also invokes the build through `prepare`.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single quotes, no semicolons, trailing commas in multiline constructs, and explicit types at module boundaries. This is an ESM/NodeNext project; source-to-source imports use `.js` extensions, while tests may import `.ts` files. Use `camelCase` for functions and variables, `PascalCase` for classes and types, and descriptive lowercase filenames. Preserve strict-null and unchecked-index handling rather than bypassing them with broad assertions.

## Testing Guidelines

Vitest discovers `tests/**/*.spec.ts`; name new tests after the module or behavior under test. Prefer deterministic unit tests and explicit state fixtures. Worktree tests must use the temporary-repository helpers and clean up resources in `afterEach`. Add regression coverage for bug fixes, especially around budgets, locks, path validation, state persistence, and merge safety. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use short imperative summaries describing the outcome, for example: `Refuse empty PASS merges and persist a wedged abort.` Keep commits narrowly scoped and include tests with behavioral changes. Pull requests should explain the user-visible effect, affected state transitions or safety invariants, and verification commands. Link relevant issues or ADRs; include configuration examples for operator-facing changes. Screenshots are only necessary when documentation gains a visual artifact.
