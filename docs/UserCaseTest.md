# User-case tests (0.1–0.2.3)

Default `agentBackend: noop` does not spawn workers. These cases map product flows to automated specs. Manual checks after install are listed at the end.

| ID | Actor | Flow | Automated spec |
|---|---|---|---|
| UC-01 | Operator | Write `GOAL.md` to arm the workspace | `tests/flow.spec.ts` (pipeline), `tests/persist.spec.ts` |
| UC-02 | Loop | No tasks → record `plan` | Plan 0.1.3 / Features F1 in `tests/one-to-one.spec.ts` |
| UC-03 | Operator | Inject a ready task → record `delegate` | `tests/flow.spec.ts` |
| UC-04 | Operator | Mark `review_pending` → record `review` | `tests/flow.spec.ts` |
| UC-05 | Operator | Mark `merge_ready` → record `merge` | `tests/flow.spec.ts` |
| UC-06 | Operator | Mark `done` → `stop` / kill switch | `tests/flow.spec.ts` |
| UC-07 | Reviewer | Rework after failed review → retry delegate | `tests/flow.spec.ts`, `tests/persist.spec.ts` |
| UC-08 | Budget | Exhausted attempts halt and stay halted | `tests/flow.spec.ts`, Plan 0.1.4 |
| UC-09 | Security | High-risk ready task escalates | Features P4 in `tests/one-to-one.spec.ts` |
| UC-10 | Install | Package is a DSH bundle plugin | Plan 0.1.2 in `tests/one-to-one.spec.ts` |
| UC-11 | Operator | Opt-in `agentBackend: dsh` spawns one-shot headless; default stays Noop | Plan 0.2.3 in `tests/dsh.spec.ts`, `tests/one-to-one.spec.ts` |

## Manual after GitHub publish

1. `pnpm install && pnpm test && pnpm build`
2. After GitHub Release `v0.2.3` exists, install as in [`Install.md`](./Install.md) (`github:jhfnetboy/DevLoop#v0.2.3` or the Release tarball). Until then, `github:jhfnetboy/DevLoop` tracks `main`.
3. Confirm an unarmed repo stays idle
4. Copy the bundled `templates/GOAL.md` (from `node_modules/dsh-devloop` after install, or this checkout) to `<repo>/.devloop/GOAL.md` and confirm the host logs a `plan` tick
5. Default `agentBackend` must not spawn `dsh`; `agentBackend: dsh` may spawn one-shot headless
