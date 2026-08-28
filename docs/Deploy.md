# Deploy

For maintainers cutting a GitHub Release (and later npm). End-user install: [Install.md](./Install.md).

## Preconditions

- Node `^22.19.0 || >=24.0.0`, pnpm (`packageManager` in `package.json`)
- `main` contains the slices you intend to ship
- `package.json` `version` matches the tag you will push (`vX.Y.Z`)
- Working tree clean; `pnpm test` green
- Do not commit the stray nested `DevLoop/` directory if it appears in the working tree (also gitignored)

## Build and test

```bash
pnpm install
pnpm test
pnpm build
```

`lib/` is gitignored. `prepare` rebuilds it on git installs. `pnpm pack` also runs `prepare`, so the tarball contains `lib/`.

Pack and inspect (this repo’s pnpm `10.6.3` has no `pack --dry-run`; `*.tgz` is gitignored):

```bash
pnpm pack
tar -tzf dsh-devloop-0.2.3.tgz
rm -f dsh-devloop-0.2.3.tgz
```

Expected contents: `package.json`, `cordis.patch.yml`, `lib/**`, `templates/**`, `docs/Install.md`, `docs/Release.md`, `docs/Deploy.md`, plus npm defaults (`README.md`, `LICENSE`). No `src/`, no tests, no `.devloop/`.

## GitHub Release

Do this immediately after the version bump is on `main`, in the same sitting, so Install.md’s `#v0.2.3` commands are not a 404:

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.2.3 -m "dsh-devloop 0.2.3"
git push origin v0.2.3
pnpm pack
gh release create v0.2.3 \
  --title "0.2.3" \
  --notes-file docs/Release.md \
  dsh-devloop-0.2.3.tgz
```

Pin installs to `github:jhfnetboy/DevLoop#v0.2.3`. Attach the `.tgz` so operators can skip git `prepare` / build approval.

## npm registry (when logged in)

Only when `npm whoami` succeeds, `HEAD` **is** the release tag (`git rev-parse HEAD` equals `git rev-parse v0.2.3`), the tree is clean, and `pnpm test` is green.

Publish the **inspected tarball** from `main` while it still points at the tag commit (do not `git checkout v0.2.3`: detached HEAD makes pnpm 10.6.3 fail with `ERR_PNPM_GIT_UNKNOWN_BRANCH`):

```bash
git checkout main
git pull --ff-only origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse v0.2.3^{commit})"
pnpm pack
pnpm publish ./dsh-devloop-0.2.3.tgz --access public
```

This package is unscoped; the tarball is public. Then operators can `dsh plugin --profile web add dsh-devloop@0.2.3` with no git `prepare`.

If `npm whoami` fails, do not invent a token. GitHub Release + `github:` spec is the supported distribution until login exists.

## Do not

- Force-push tags
- Publish from a dirty working tree
- Treat Plan 0.2.4 / 0.2.5 as shipped because this tag exists
