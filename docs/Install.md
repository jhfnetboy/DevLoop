# Install

For operators who want `dsh-devloop` in a DeepSeek Harness profile. Maintainer cut/tag steps: [Deploy.md](./Deploy.md). What this version includes: [Release.md](./Release.md).

Pinned `#v0.2.3` commands and the Release tarball link need the GitHub Release created **after** the version bump is on `main` (see Deploy.md). Until that Release exists, install from current `main` (moving branch, not a pin):

```bash
dsh plugin --profile web add github:jhfnetboy/DevLoop
```

## Requirements

- Node `^22.19.0 || >=24.0.0` (Node 23 is not in the DSH engines range)
- pnpm (the copy `dsh plugin` forwards to; this repo pins `10.6.3`)
- DeepSeek Harness CLI (`npm i -g @deepseek-ai/dsh`, or `pnpm dsh` from a harness checkout)
- A profile you already boot (`dsh web`, or another named profile)

## GitHub git spec (runs `prepare`)

After `v0.2.3` exists, pin the tag:

Quote the spec: zsh treats `#` as a glob (`no matches found`).

```bash
dsh plugin --profile web add 'github:jhfnetboy/DevLoop#v0.2.3'
```

Git installs fetch source, not `lib/`. This package’s `prepare` script runs `pnpm build`. pnpm ≥10 will not run that until you allow the package to run scripts.

On pnpm 10.1–10.25, `strictDepBuilds` is often unset: **`pnpm add` can exit 0 and only print `Ignored build scripts: dsh-devloop`**. That is not a successful plugin install. DSH will then load a checkout with no `lib/` and fail on restart. Approve the build whenever pnpm reports an ignored (or blocked) build for this package, even after a successful `add`. Then run a **fresh** `dsh plugin ... add` (same spec). Do not use `pnpm rebuild`: this package only has `prepare`, and `src/` is not in the installed tree, so rebuild cannot produce `lib/`.

**Use the key and field name pnpm printed** — do not assume a single YAML shape.

Typical profile file: `~/.dsh/profiles/web/pnpm-workspace.yaml`.

pnpm 10.1–10.25:

```yaml
onlyBuiltDependencies:
  - dsh-devloop
```

pnpm ≥10.26:

```yaml
allowBuilds:
  dsh-devloop: true
```

You can also approve from the profile directory:

```bash
pnpm --dir ~/.dsh/profiles/web approve-builds
```

Allow `dsh-devloop` when prompted, then re-run the same `dsh plugin --profile web add ...` so pnpm fetches the git package with `prepare` allowed. Do not use `pnpm rebuild`. Treat that allowance as permission to execute this package’s install-time scripts on your machine.

Restart the profile (`dsh web`) and confirm the layer:

```bash
dsh --profile web --dump-config | grep -A2 devloop
```

You should see a `# == dsh-devloop` layer and an inserted row `id: devloop`.

## GitHub Release tarball (no `prepare`)

After the [v0.2.3 Release](https://github.com/jhfnetboy/DevLoop/releases/tag/v0.2.3) exists, download `dsh-devloop-0.2.3.tgz`, then:

```bash
dsh plugin --profile web add ./dsh-devloop-0.2.3.tgz
```

The tarball already contains `lib/`, so pnpm does not need a build allowance.

## npm registry

Not published yet. When `dsh-devloop@0.2.3` is on npm:

```bash
dsh plugin --profile web add dsh-devloop@0.2.3
```

## Local checkout

```bash
git clone https://github.com/jhfnetboy/DevLoop.git
cd DevLoop
git checkout v0.2.3   # or main, until the tag exists
pnpm install
pnpm test
pnpm build
dsh plugin --profile web add /absolute/path/to/DevLoop
```

From this checkout, the Goal template is `templates/GOAL.md`.

## Config

Optional overrides in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: devloop
  config:
    root: /path/to/your/project
    tickIntervalMs: 2000
    agentBackend: dsh
    budget:
      maxCostUsdPerDay: 20
      taskTimeoutMinutes: 45
      taskLifetimeMinutes: 135
```

`agentBackend` defaults to `noop` (no spawn). Set `dsh` only when the host can run `dsh --profile headless`.

## Arm a project

The plugin is idle until the target workspace contains `.devloop/GOAL.md` (a regular file, not a symlink). A bare `.devloop/` directory does not arm it.

After a GitHub or tarball install:

```bash
mkdir -p /path/to/your/project/.devloop
cp ~/.dsh/profiles/web/node_modules/dsh-devloop/templates/GOAL.md \
  /path/to/your/project/.devloop/GOAL.md
```

Or fetch the template without a clone (use `main` instead of `v0.2.3` until the tag exists):

```bash
mkdir -p /path/to/your/project/.devloop
curl -fsSL https://raw.githubusercontent.com/jhfnetboy/DevLoop/v0.2.3/templates/GOAL.md \
  -o /path/to/your/project/.devloop/GOAL.md
```

Edit `GOAL.md`, then start DSH from that project (or set `config.root`). Each tick writes `.devloop/STATE.json` with `lastAction`.

Until 0.2.5, PASS/REWORK is still operator-driven (or whatever writes `lastReviewVerdict` on the task). After Review `PASS` / `PASS_WITH_NOTES`, the next tick git-merges `devloop/<taskId>` into the workspace HEAD, deletes the worktree, and marks the task `done`. It does not push. `merge_ready` without PASS escalates. If STATE shows `supervisor.reason: merge_wedged`, the workspace is stuck mid-merge: run `git merge --abort` in the project root, confirm a clean tree, then clear the supervisor hold.

## Uninstall

```bash
dsh plugin --profile web remove dsh-devloop
```
