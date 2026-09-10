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
| 2 | Actions: answer a gate, resume, and an operator pause; resume re-arms the loop's timer in process | the CLI's verbs, plus pause |
| 3 | Projects: register a git repository, write its GOAL.md, start its loop; unregister. A loop per project, a global daily cost cap and a global concurrency cap across all of them | starting a loop |

### Phase 1

Projects come from two places: the process's own `root` (the directory DSH was
started in), and a registry at `$DSH_HOME/devloop/projects.json`. In phase 1 the
registry is read-only — edited by hand — and only the process's own root has a
running loop; other projects' state is shown as found on disk, labelled as not
running here.

### Phase 2 — decisions to make before building

- **Pause is new state vocabulary.** Nothing lets an operator stop a running
  loop today: `killSwitch` is set only by the loop on its own way out, and
  `answer stop` exists only while a gate is pending. A pause has to be a
  persisted hold with its own reason, so `status`, the gate and `resume` all
  understand it — not an in-memory flag a restart forgets.
- **Resume must re-arm.** `DevloopService.stop()` sets `disposed`, so a halted
  loop cannot restart without restarting the profile (tracked in
  `V0.5-TODO.md`). Halting and disposal become separate.

### Phase 3 — decisions to make before building

- **One loop per project.** `DevloopService` binds one `root`; it becomes a
  registry of per-project loops, each with its own timer, `busy` flag, lock and
  state. The per-project code is unchanged in shape; what is new is ownership.
- **Budgets across projects.** Each project's `STATE.json` carries its own
  `costUsdDay`, so N projects can spend N daily caps. A global cap sums them.
- **Concurrency across projects.** One dispatch per project behind `busy` is N
  concurrent dispatches for N projects. `maxParallelWorkers` becomes the global
  bound.
- **Registering a project is choosing where agents run.** The path must be an
  existing git toplevel (the worktree code already refuses anything else),
  resolved to its realpath, and is an operator decision recorded with a
  timestamp.
