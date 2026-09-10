# Dashboard

A management page for every project the loop runs, reachable from any device on
the operator's tailnet: see what each loop is doing, answer its questions, start
and stop it.

One project is one requirement: a git repository with a `.devloop/GOAL.md`.
Starting it starts a loop, which plans the goal into tasks and works through
them. The page lists every project and runs each one's loop independently.

## Phase 0 — what was verified before any code

Everything in this section was run against DSH `0.1.2-rc.1` on this machine,
not read off a README.

### Remote access is DSH's own, not ours

`dsh-host-webserver` accepts exactly two bind hosts, `127.0.0.1` and `0.0.0.0`,
and serves nothing with authentication of its own. `0.0.0.0` exposes every
interface — the café's Wi‑Fi included — and `dsh-client-connection` states that
`dsh web --host 0.0.0.0` is unsupported. So DSH stays on loopback and Tailscale
carries the tailnet to it:

```bash
tailscale serve --bg --tcp 3080 tcp://127.0.0.1:3080
dsh web --no-open \
  --trusted-host 100.107.243.106 \
  --trusted-host jasons-mac-mini.taild199fd.ts.net \
  --trusted-host jasons-mac-mini
```

`--tcp`, not `--http`: an HTTP serve routes on the `Host` header and only
answers to the MagicDNS names, so a browser pointed at the tailnet IP gets
Tailscale's own `404 page not found`. A TCP forwarder does not read `Host`, so
the IP and both names all reach DSH — and DSH's own fence then decides.

Measured, through the forwarder:

| Request | Result | Meaning |
|---|---|---|
| tailnet name, no `--trusted-host` | 403 | the proxy preserves `Host`, and DSH's fence refuses it |
| IP or either name, with `--trusted-host` | 401 | trusted host, not yet logged in |
| forged `Host: evil.example` | 403 | still refused |
| `GET /?token=…` on the IP | 303 → `/` | token exchanged for a signed cookie |
| `/api/…` with that cookie | 404 | authenticated; the route simply does not exist |
| the same cookie against the name | 401 | cookies bind `host:port`, so pick one address and keep it |

The cookie is `HttpOnly`, `SameSite=Strict`, 30 days, signed with a secret
persisted in `$DSH_HOME/.credentials.yaml` — so it survives DSH restarts, and
the per-launch token is needed once per browser, not once per launch. It is not
`Secure`; tailnet traffic is WireGuard-encrypted, which is what makes plain HTTP
over the tailnet acceptable here and nowhere else.

On this machine `dsh web` runs under launchd
(`~/Library/LaunchAgents/com.jhfnetboy.dsh-web.plist`, log
`~/Library/Logs/dsh-web.log`, mode 600 because it carries the login token).

### Why the vendor's transport is not reused

`dsh-dev-loop` registers its own POST routes with `ctx.webServer.register` and
guards them with a check that the socket's remote address is loopback. Behind
`tailscale serve`, **every** request's remote address is `127.0.0.1` — the
forwarder connects from this machine — so that check admits the whole tailnet,
unauthenticated, to an endpoint that starts work. Loopback is a location, not an
identity.

### How a plugin gets DSH's authentication

`ctx.connection` (host half of `dsh-client-connection`) exposes, among others:

- `requestRejection(request)` — *"apply Connection's Host/Origin checks and
  browser authentication to another Web route"*. Returns `401`, `403`, or
  `undefined` to proceed.
- `rpc.handle(channel, handler)` — an authenticated RPC channel.
- `fetch.register({ path, methods: ['GET' | 'HEAD'], fetch })` — read-only routes
  below `/api`.

No Typert code generation is needed, which was the largest unknown going in.
The dashboard uses the first: its own routes, every request passed through
`requestRejection` before anything else. That is the same cookie, the same Host
fence, and — because the fence rejects a mismatched `Origin` and
`sec-fetch-site: cross-site` — the same CSRF defence as DSH's own API.

### Why a page, not a panel

The vendor's panels live inside DSH's chat UI and need a client half: a tsdown
build, React, DSH's `__ModuleLoader__` contract, and `@deepseek-ai/dsh-client-ui-*`
packages that are still release candidates and broke the vendor once at
`0.1.2-rc.1`. A management page for many projects does not fit a sidebar panel
anyway. So the dashboard is a standalone page at `/devloop/`, served by the host
half through DSH's webserver. The package keeps its plain `tsc` build and gains
no browser dependencies.

The dashboard needs `webServer` and `connection`, which only the web profile
has. It is mounted with `ctx.inject(['webServer', 'connection'], …)`, so the
loop itself still starts in `tui` and `headless` profiles, and the page appears
only where there is a browser to show it.

## Rules the dashboard does not bend

- **Every request is authenticated.** `requestRejection` runs before routing,
  static assets included.
- **Buttons are the CLI's verbs, not new powers.** An answer goes through the
  same `applyAnswer` under the same state lock as `devloop answer`. The page is
  never a way to write `STATE.json`, which Release.md already forbids operators
  from doing by hand.
- **Only registered projects are readable.** Requests name a project by an
  opaque id derived from its realpath, never by a path, so the page cannot be
  used to read an arbitrary directory.
- **Model-written text is rendered as text.** Task titles, gate evidence and
  event records come from model output; the page sets `textContent`, never
  `innerHTML`, and ships a CSP with no inline script.
- **Remote start is remote spending.** Budget caps and gates apply exactly as
  they do locally; the page adds no path around either.

## Phases

| Phase | Ships | New authority |
|---|---|---|
| 0 | Remote access and the findings above | none |
| 1 | Read-only page: project list; per project the tasks, halt reason, pending gate and its options, budget and cost, last events, PROGRESS | none — reads only |
| 2 | Actions: answer a gate, resume, and an operator pause; a halted loop waits instead of disposing its timer | the CLI's verbs, plus `devloop pause` |
| 3 | Projects: register a git repository, write its GOAL.md to start its loop, unregister. A loop per project; a shared daily cost cap and shared dispatch slots across them | registering a repository; starting a loop |

### Phase 1

Projects come from two places: the process's own `root` (the directory DSH was
started in), and a registry at `$DSH_HOME/devloop/projects.json`. Phase 1 read
both and wrote neither.

### Phase 2 — as built

- **One implementation, two surfaces.** `operator.ts` holds `answerGate`,
  `resumeLoop` and `pauseLoop`; `devloop answer|resume|pause` and the page's
  three POSTs all call them, under the same lock. The journal labels a page
  write `answer:retry@dashboard`, so a change made from another device is
  distinguishable after the fact.
- **A write names the state it answers.** Every POST carries the revision the
  page was showing, and a moved state is refused with 409 rather than applied
  to a question the operator never saw. Bodies must be `application/json` (a
  cross-site form cannot send that without a preflight), are capped at 4 KB,
  and `answer` accepts only the four gate keys.
- **Pause is state, not a flag in memory.** `paused: { at, via }` beside
  `killSwitch: true` and `lastAction: stop:kill_switch`, so every existing
  halted path applies unchanged and a restart forgets nothing. It asks no
  question — `gateFor` returns null for it — because the only reply is resume;
  and it refuses a loop that is already halted, which would bury the question
  that halt is asking. A malformed record degrades to none: `killSwitch` is
  what stops the loop, so dropping the annotation loses the who and when, never
  the halt. On the page's own project a pause also aborts the dispatch in
  flight, whose result would be discarded as stale anyway; it still counts as
  an attempt.
- **A halted loop keeps its timer.** `stop()` is disposal only. A halted tick
  peeks at STATE without the lock and returns, writing nothing, while the
  revision is the one it already saw halted; any answer, resume or pause moves
  the revision and the next tick acts on it. This closes the `V0.5-TODO.md` item
  "re-arm a running service after a resume" for the CLI as much as for the page.
  The test that documented the old limitation passed for the wrong reason — its
  workspace was not a git repository, so the dispatch it counted never reached
  a backend with or without a timer — and is replaced by one that watches the
  journal.

### Phase 3 — as built

- **One loop per project.** The old service body is now `ProjectLoop`, unchanged
  in shape; `DevloopService` owns the process's own loop plus one per registered
  project, all sharing one backend and one profile config, differing only in
  `root`. Every registered project gets a loop at startup, and a loop without a
  GOAL.md idles — exactly the rule the own root always had — so arming a project
  *is* starting it. There is no second "running" flag to fall out of step with
  the files, and a restart resumes everything that was armed.
- **Budgets across projects.** `LoopShared` sums each loop's `costUsdDay`
  (rolled to today, so yesterday's spend is not counted) and, once the total
  reaches `maxCostUsdPerDayAllProjects`, no loop starts new work until UTC
  midnight. Unset, that cap equals one project's `maxCostUsdPerDay`: adding
  projects never raises what a day can cost. It is not consulted with a single
  loop, whose own cap already halts it with a gate naming the cause. It sees
  only what backends report — dsh headless reports nothing.
- **Concurrency across projects.** A loop takes one of `maxParallelWorkers`
  shared slots for any tick that reaches the state lock, and holds it through
  that tick's dispatch. A refused loop waits rather than halts: a halt would
  ask its own project a question whose answer is in another project.
- **Registering is choosing where agents run.** A root must be an existing git
  toplevel with a real (not symlinked) `.devloop`, is stored by realpath, and
  the registry is rewritten atomically. A registry the page cannot parse is
  refused rather than overwritten, and fields it does not know are kept.
- **Starting writes GOAL.md, once.** Created with `O_EXCL | O_NOFOLLOW`, so it
  neither replaces an existing goal nor follows a planted symlink. A goal
  changed under a running loop would leave it working through tasks planned for
  a different one, so an existing goal is edited by hand.
- **Removing forgets, and deletes nothing.** A running loop must be paused
  first, so the decision to abandon its work is in its journal. The own root
  cannot be removed. `.devloop/`, worktrees and branches stay where they are.
- **The own root is hidden when it can never be a project** — unarmed and not a
  repository, which is what launchd gives DSH as its working directory.

Not done, deliberately: editing an existing goal from the page, and picking up a
registry edited by hand while DSH runs (restart to apply). Task claims and
leases stay deferred: projects now run in parallel, but each project still runs
one dispatch at a time, so a lease still has no consumer.
