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
tar -tzf jhfnetboy-dsh-devloop-0.6.4.tgz
rm -f jhfnetboy-dsh-devloop-0.6.4.tgz
```

Expected contents: `package.json`, `cordis.patch.yml`, `lib/**`, `templates/**`, `docs/Install.md`, `docs/Release.md`, `docs/Deploy.md`, plus npm defaults (`README.md`, `LICENSE`). No `src/`, no tests, no `.devloop/`.

## GitHub Release

Do this immediately after the version bump is on `main`, in the same sitting, so Install.md’s `#v0.6.4` commands are not a 404:

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.6.4 -m "dsh-devloop 0.6.4"
git push origin v0.6.4
pnpm pack
gh release create v0.6.4 \
  --title "0.6.4" \
  --notes-file docs/Release.md \
  jhfnetboy-dsh-devloop-0.6.4.tgz
```

Pin installs to `'github:jhfnetboy/DevLoop#v0.6.4'` (quotes required on zsh). Attach the `.tgz` so operators can skip git `prepare` / build approval.

## npm registry (when logged in)

Only when `npm whoami` succeeds, `HEAD` **is** the release tag (`git rev-parse HEAD` equals `git rev-parse v0.6.4`), the tree is clean, and `pnpm test` is green.

Check `npm whoami --registry=https://registry.npmjs.org/`, not bare `npm whoami`: a machine configured against a mirror answers for the mirror, which reports "not logged in" for an account that is, and cannot accept a publish either way. `publishConfig` in `package.json` pins the publish registry, so the flags below are belt and braces rather than the thing that makes it work.

Publish the **inspected tarball** from `main` while it still points at the tag commit (do not `git checkout v0.6.4`: detached HEAD makes pnpm 10.6.3 fail with `ERR_PNPM_GIT_UNKNOWN_BRANCH`):

```bash
git checkout main
git pull --ff-only origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse v0.6.4^{commit})"
pnpm pack
pnpm publish ./jhfnetboy-dsh-devloop-0.6.4.tgz --access public
```

This package is scoped and published with `--access public` (set in `publishConfig`); the tarball is public. Then operators can `dsh plugin --profile web add @jhfnetboy/dsh-devloop@0.6.4` with no git `prepare`.

If `npm whoami` fails, do not invent a token. GitHub Release + `github:` spec is the supported distribution until login exists.

## Do not

- Force-push tags
- Publish from a dirty working tree
- Treat the later 0.5 operator surface as shipped because this tag exists
