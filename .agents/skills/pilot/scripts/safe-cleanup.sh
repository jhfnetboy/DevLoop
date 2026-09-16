#!/usr/bin/env bash
# safe-cleanup.sh — report what is safely cleanable; delete only what git itself will vouch for.
#
# Guarantees (do not weaken these):
#   * The ONLY thing this script deletes is a local branch via `git branch -d`, under --apply.
#     `-d` is git's own safety net: it refuses anything git cannot see as merged, so it cannot
#     destroy unmerged work, and it refuses a branch a worktree is using.
#   * NEVER `git branch -D`. NEVER `git push --delete`. NEVER `git worktree remove` — that last one
#     is a FILESYSTEM delete and took gitignored files (a real `.env`) with it; see below.
#   * Never touch: the current branch, the integration branch, or any protected branch.
#   * Worktrees: REPORTED only, with the command to remove them. Never removed.
#   * Remote branches: NOT HANDLED AT ALL — not deleted, not listed. Use GitHub's
#     auto-delete-on-merge, which judges server-side where the merge happened.
#
# Squash-merged branches (--squash-merged, opt-in):
#   In a squash-merge repo `git branch --merged` returns NOTHING, ever — the squash rewrites the
#   patch so the original commits are not ancestors of the integration branch. Measured here:
#   28 local branches, `git branch --merged main` → 0. So `git branch -d` alone can never clean
#   this repo, and the section that uses it is honest but useless here.
#
#   `--squash-merged` adds a SECOND source of merge evidence: GitHub's `/commits/{sha}/pulls`
#   says which PR introduced a commit to the repository. A branch is reported only when that
#   endpoint names a PR with `merged_at != null` for the branch's tip commit.
#
#   Why keyed on the COMMIT and not the branch name — both directions of the name-based mistake
#   are real and were hit here:
#     * miss  — `work-pr18` / `worktree-agent-*` were never any PR's head branch, yet their tips
#               were the merged heads of #18 / #23. A name lookup calls them unmerged.
#     * WRONG  — branch names are reusable. Delete a branch, recreate it with unrelated work, and
#               the old MERGED PR still matches the name. A name lookup would name it cleanable.
#   The commit-keyed check has neither failure mode. Verified against all four shapes:
#   squash-merged head ✓, mid-branch commit ✓, closed-but-unmerged → no evidence ✓,
#   never-had-a-PR → no evidence ✓.
#
# Why listing, not deleting:
#   Cleaning these needs `-D` (`-d` refuses — git cannot see the merge). An earlier version did
#   exactly that, and six review rounds on that one capability found six real, reproduced defects:
#   a same-named tag hijacking the evidence so an UNMERGED branch was deleted; a recovery handle
#   printing a DIFFERENT branch's name (bash 3.2 expands the right-hand side of a multi-assignment
#   `local` in the OUTER scope); the loss of git's own "that ref is checked out by a worktree"
#   refusal; a TOCTOU window between evidence and delete; and a server-side delete judged by the
#   operator's LOCAL branch, which removed a colleague's unmerged work from the remote.
#
#   None of those was theoretical and none was the reviewer being picky — each was reproduced end
#   to end. The conclusion was not "defend harder". Automating an IRREVERSIBLE delete, on evidence
#   inferred from a server, demands a level of assurance that what it buys — not typing
#   `git branch -D <name>` — does not justify. Every one of those six defects was a property of
#   DELETING, not of listing.
#
#   So: this script does the part that is genuinely hard (working out which branches are merged,
#   with per-branch evidence, in a repo where git itself cannot tell you) and leaves the part that
#   is trivial-but-unrecoverable to you. For remote branches, GitHub's auto-delete-on-merge already
#   does it server-side, where the merge happened — strictly better than inferring it from a clone.
#
#   That sweep had to be done TWICE. The first pass removed the ref writes (`-D`, `push --delete`)
#   and declared victory — while `git worktree remove` was still there, newly wired to the same
#   inferred evidence, deleting whole directories including gitignored files that `git status
#   --porcelain` never shows. "No irreversible deletes" was written in this header while the
#   filesystem delete four screens down was live. When auditing for destructive actions, ref writes
#   are the ones you think of; the filesystem ones are the ones that actually lose data.
#
# Usage:
#   safe-cleanup.sh [--integration <branch>] [--protect "a,b,c"] [--apply] [--squash-merged]
#                   [--remote] [--remote-name origin]
# ---8<--- end of header ---8<---
set -euo pipefail

integration=""
protect_csv="main,master,develop,preview,integration,release,hotfix"
apply=0
squash_merged=0
do_remote=0
remote_name="origin"

# Unknown arguments are REFUSED, not skipped. `*) shift ;;` silently dropped a typo like
# `--integraton main`, and `integration` then fell back to a guess from origin/HEAD — so
# `--apply` would delete against a baseline the caller never asked for. `--integration` is the
# one argument whose typo is unrecoverable, and run.md requires callers to pass it explicitly.
# (Same reasoning that turned git-guard's flag denylist into a refuse-unknown allowlist in this
# very commit; it applies here for identical reasons.)
# Counting arity is not enough: `--protect --apply` passed the arity test and swallowed --apply,
# so the script printed mode=DRY-RUN and exited 0 while the caller believed it had run. Same
# silent-swallow class B2 exists to close.
need_val() {
  [ "$2" -ge 2 ] || { echo "safe-cleanup: '$1' requires a value" >&2; exit 2; }
  case "$3" in
    -*) echo "safe-cleanup: '$1' requires a value, got flag '$3'" >&2; exit 2 ;;
    "") echo "safe-cleanup: '$1' requires a non-empty value" >&2; exit 2 ;;
  esac
}
while [ $# -gt 0 ]; do
  case "$1" in
    --integration)   need_val "$1" $# "${2:-}"; integration="$2"; shift 2 ;;
    --protect)       need_val "$1" $# "${2:-}"; protect_csv="${protect_csv},$2"; shift 2 ;;
    --remote-name)   need_val "$1" $# "${2:-}"; remote_name="$2"; shift 2 ;;
    --apply)         apply=1; shift ;;
    --squash-merged) squash_merged=1; shift ;;
    --remote)        do_remote=1; shift ;;
    # `grep '^#'` keeps comment lines — but the sentinel IS a comment line, so it was printed
    # verbatim at the end of every --help. Drop it explicitly.
    -h|--help)       sed -n '2,/^# ---8<--- end of header ---8<---$/p' "$0" | grep '^#' | grep -v '^# ---8<---'; exit 0 ;;
    *) echo "safe-cleanup: unknown argument '$1'" >&2
       echo "  usage: safe-cleanup.sh [--integration <b>] [--protect \"a,b\"] [--apply] [--squash-merged] [--remote] [--remote-name <r>]" >&2
       exit 2 ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not-a-git-repo"; exit 0
fi

current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo DETACHED)"

if [ -z "$integration" ]; then
  if git symbolic-ref --quiet refs/remotes/origin/HEAD >/dev/null 2>&1; then
    integration="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  fi
  [ -z "$integration" ] && for c in main master; do
    git show-ref --verify --quiet "refs/heads/$c" && { integration="$c"; break; }
  done
fi
if ! git show-ref --verify --quiet "refs/heads/$integration"; then
  echo "ERROR: integration branch '$integration' not found locally; refusing to guess. Pass --integration." >&2
  exit 1
fi
# Use the FULL ref everywhere the integration branch is resolved. As a bare name it is subject to
# the same tag-beats-branch precedence as any other: with a tag also called `main`, `git branch -r
# --merged main` answered about the TAG's commit and listed `origin/unmerged-precious` as merged.
# Back when §3 still deleted, `--apply` destroyed that branch server-side; it only lists now, but a
# wrong list is still a wrong instruction to paste. The ambiguity warning git prints was being
# swallowed by `2>/dev/null`, so nothing surfaced.
integration_ref="refs/heads/$integration"

is_protected() {
  local name="$1"
  [ "$name" = "$current_branch" ] && return 0
  [ "$name" = "$integration" ] && return 0
  # Split with `read -ra`, not word-splitting, and trim with parameter expansion, not `echo | xargs`.
  # xargs parses SHELL QUOTING, so it mangled exactly the names that most need protecting:
  # `a\b` came back as `ab`, and `keep'me` (a legal refname) killed xargs on an unterminated quote,
  # yielding an empty string that the `continue` below silently dropped — the branch then fell
  # through to the `-D` path. Measured: `--protect "keep'me"` printed `would delete keep'me`.
  # `set -f` so a pattern like `rel*` is compared literally instead of being glob-expanded against
  # the working directory.
  local -a pats=(); local p
  set -f
  IFS=',' read -ra pats <<< "$protect_csv"
  set +f
  for p in "${pats[@]}"; do
    p="${p#"${p%%[![:space:]]*}"}"   # trim leading whitespace
    p="${p%"${p##*[![:space:]]}"}"   # trim trailing whitespace
    p="${p%/}"                       # tolerate trailing slash (e.g. "hotfix/")
    [ -z "$p" ] && continue
    [ "$name" = "$p" ] && return 0
    # Boundary set copied VERBATIM from git-guard.sh's is_protected. The two scripts ship in the
    # same skill and must not disagree about what "protected" means: with the old `"$p"/*` a
    # `release-1.2` that git-guard REFUSES to push to was still offered here as a deletion
    # candidate. Harmless while this script only used `-d`; this PR added `-D`, which turns the
    # divergence into data loss. `[-_/.0-9]` (not `*`) so `main` cannot swallow `mainline`.
    case "$name" in "$p"[-_/.0-9]*) return 0 ;; esac
  done
  return 1
}

# ---- squash-merge evidence (read-only; no fetch, no ref writes, so dry-run stays read-only) ----
# Resolved once, lazily: most repos never need it, and `gh` may not be installed at all.
gh_state="unknown"   # unknown | ready | unavailable
gh_repo=""
gh_init() {
  [ "$gh_state" = "unknown" ] || return 0
  gh_state="unavailable"
  command -v gh >/dev/null 2>&1 || return 0
  gh auth status >/dev/null 2>&1 || return 0
  gh_repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
  [ -n "$gh_repo" ] && gh_state="ready"
  return 0
}

# Echo one of three things, and the difference matters:
#   <number>  a MERGED PR whose BASE is $integration introduced this branch's tip commit
#   ERR       the lookup itself failed (rate limit, 5xx, missing scope) — verdict UNKNOWN
#   (empty)   the lookup succeeded and found no such PR — no evidence
#
# `.base.ref == $integration` is load-bearing, not decoration. Without it the test is merely
# "some merged PR touched this tip", which a STACKED PR satisfies: child merged into a parent
# feature branch, parent's own PR later closed unmerged — the child's tip then carries merge
# evidence forever while its work never reached the integration branch. Measured in a sandbox:
# a commit `git merge-base --is-ancestor … main` calls unreachable was still offered for
# deletion. Brood happens to have integration == default == main, which masks this entirely;
# pilot's documented default shape is `preview != main`, where it bites.
#
# NB: an `--is-ancestor $sha $integration` test is deliberately NOT added on top. In a
# squash-merge repo the tip is BY CONSTRUCTION never an ancestor of the integration branch —
# that is the whole reason this function exists. Requiring it would return the feature to the
# dead-code state it was written to fix. Base convergence is the correct narrowing; ancestry
# is not available here.
#
# Takes a resolved SHA, not a ref name. The caller resolves it once and keeps it, so the evidence
# and the sha that authorises the deletion are the SAME object by construction — there is no second
# resolution that could land on a different commit (or, before this round, on a same-named TAG).
merged_pr_for() {  # merged_pr_for <sha>
  local sha="$1" out rc
  gh_init
  [ "$gh_state" = "ready" ] || { printf 'ERR'; return 0; }
  [ -n "$sha" ] || return 0
  # $integration goes in as DATA via $ENV, never interpolated into the jq program. Building the
  # program by string substitution let a git-legal branch name rewrite the predicate: with
  # `x"or(true)or"` the comparison becomes `.base.ref == "x"or(true)or""` — constantly true — and
  # a merged PR whose base was some other branch then counted as evidence, ending in an
  # irreversible `git branch -D`. That is the exact failure class the base check was added to
  # close, re-entering through the check itself.
  # `rc=0; … || rc=$?` instead of a bare `$?`: under `set -e` a failing command substitution only
  # survives because bash suspends errexit inside `$( )` and `inherit_errexit` is off by default.
  # Verified: convert either call site to a non-cmdsub form and the script exits 1 silently right
  # after printing the section header, truncating the report with no error. This form keeps the
  # real status AND survives `shopt -s inherit_errexit` or a future non-cmdsub caller.
  rc=0
  out="$(PILOT_INTEG="$integration" gh api "repos/$gh_repo/commits/$sha/pulls" \
         --jq '[.[] | select(.merged_at != null and .base.ref == $ENV.PILOT_INTEG) | .number] | first // empty' 2>/dev/null)" || rc=$?
  # A failed CALL is not the same as an empty ANSWER. Rate limiting is the most likely failure
  # here precisely because this feature spends one API call per branch.
  [ "$rc" -ne 0 ] && { printf 'ERR'; return 0; }
  case "$out" in
    '') return 0 ;;            # 200 with no matching PR → genuinely no evidence
    # ENUMERATED, not a range — the same convention PR#50 established for git-guard.sh. `[!0-9]` is
    # a collation range whose membership depends on LC_COLLATE (under fa_IR/ar_SA the Eastern-Arabic
    # digits fall inside it). Not exploitable here either — the value comes from jq's ASCII
    # `.number` — but #50 made this a FILE-level convention precisely so no sibling script keeps a
    # locale-dependent notion of "is this a number"; that skill ships both of these together.
    *[!0123456789]*) printf 'ERR' ;;  # 200 but unparseable → treat as unknown, never as "no"
    *) printf '%s' "$out" ;;
  esac
}

# NO `-D` ANYWHERE. This script lists squash-merged branches; it never deletes them.
#
# It used to. Six review rounds on that one capability found six real, reproduced defects — a tag
# hijack that deleted an UNMERGED branch, a recovery handle naming a DIFFERENT branch (bash 3.2
# expands the right-hand side of a multi-assignment `local` in the OUTER scope), a lost
# "branch is checked out by a worktree" refusal, a TOCTOU window, and a server-side delete judged
# by the operator's LOCAL branch. None was theoretical; each was reproduced end to end.
#
# The lesson was not "defend harder". It was that automating an IRREVERSIBLE delete, on evidence
# that has to be inferred from a server, needs a level of assurance this feature's value does not
# justify: what it buys is not typing `git branch -D <name>`. So the delete is gone and the
# evidence-gathering stays — you get told exactly which branches are safe to remove and why, and
# you run one command. Every one of those six defects was a property of deleting, not of listing.
#
# Remote branches: GitHub's auto-delete-on-merge already does that server-side, where the merge
# actually happened, so it cannot be fooled by a local branch that has not been pushed.

# Membership tests without a pipeline. `producer | grep -Fqx` looks harmless but `grep -q` exits at
# the first match, the producer takes SIGPIPE, and with `set -o pipefail` the whole pipeline returns
# 141 — a MATCH reported as a failure. Reproduced with a 5000-line producer (`MATCH-LOST rc=141`);
# at :349 that silently demoted a git-native merged worktree branch from the `-d` path to the `-D`
# path. Pure bash matching has no producer to kill.
list_has() {  # list_has <newline-separated-list> <needle>
  case $'\n'"$1"$'\n' in
    *$'\n'"$2"$'\n'*) return 0 ;;
  esac
  return 1
}

mode="DRY-RUN (pass --apply to execute)"
[ "$apply" = "1" ] && mode="APPLY"
echo "== pilot safe-cleanup =="
echo "integration=$integration  current=$current_branch  mode=$mode  remote=$([ $do_remote = 1 ] && echo on || echo off)"
echo

# Branches currently checked out in a worktree — handled by section 2, never section 1.
wt_branches=""
while IFS= read -r line; do
  case "$line" in
    branch\ refs/heads/*) wt_branches="${wt_branches}${line#branch refs/heads/}"$'\n' ;;
  esac
done < <(git worktree list --porcelain 2>/dev/null)
is_in_worktree() { list_has "$wt_branches" "$1"; }

# Computed ONCE, from the full integration ref, and reused by every "is this already merged?" test
# below. Previously each test re-ran `git branch --merged | sed | grep -q` — three separate chances
# to hit the SIGPIPE/pipefail bug and the bare-name ambiguity, per branch.
#
# FULL refs, not `%(refname:short)`. Short-form output is DISAMBIGUATED: with a tag of the same
# name, `%(refname:short)` emits `heads/dup` rather than `dup`. That string then flowed into
# `git branch -d -- heads/dup` (→ "branch not found" → reported as `SKIP (not safely merged)`, i.e.
# a `-d`-safe branch declared unmerged) and into the §1b membership test (→ the branch was NOT
# recognised as already handled, so it came back round on the `-D` evidence path). Full refs are
# unambiguous by construction, and every consumer below strips the prefix for display/deletion.
git_merged_refs="$(git branch --format='%(refname)' --merged "$integration_ref" 2>/dev/null || true)"

# ---- 1. Merged local branches ------------------------------------------------
echo "## Local merged branches"
merged_list=()
while IFS= read -r mref; do
  [ -z "$mref" ] && continue
  b="${mref#refs/heads/}"
  if is_protected "$b"; then continue; fi
  if is_in_worktree "$b"; then continue; fi   # leave worktree branches to section 2
  merged_list+=("$b")
done <<< "$git_merged_refs"

if [ "${#merged_list[@]}" -eq 0 ]; then
  echo "  (none)"
else
  for b in "${merged_list[@]}"; do
    if [ "$apply" = "1" ]; then
      # -d refuses unmerged; safe even if state changed since listing.
      if git branch -d -- "$b" 2>/dev/null; then echo "  deleted  $b"; else echo "  SKIP (not safely merged)  $b"; fi
    else
      echo "  would delete  $b"
    fi
  done
fi
echo

# ---- 1b. Squash-merged local branches (evidence-based; opt-in) ---------------
# Separate section on purpose: these need `-D`, so they must never be confused with the
# `-d`-safe list above. A branch appears here ONLY with a merged-PR number attached.
echo "## Squash-merged local branches"
# Probe HERE, in the main shell. `merged_pr_for` is only ever called as `$( ... )`, which runs in
# a SUBSHELL — anything it assigns to gh_state is discarded on return. Relying on that left the
# "cannot verify" branch permanently unreachable, so a missing/unauthenticated gh printed the
# same "(none)" as a genuinely clean repo. "Could not check" must never look like "nothing found".
# COST GATE. ONE gh call per candidate, in both dry-run and apply. (Round 4 briefly made apply 2N
# by re-querying to close the TOCTOU window; `update-ref`'s expected-old-value does that atomically
# instead, so the number below is accurate again — rate limiting is this feature's most likely
# failure mode and doubling the calls made it twice as easy to hit.) A plain `pilot status` dry-run measured
# 25 calls / 20.6s on this repo, and status.md step 4 runs exactly that. Without --squash-merged
# spend ZERO calls and say so — silence would be indistinguishable from "nothing found", the very
# confusion B3 exists to prevent.
if [ "$squash_merged" != "1" ]; then
  echo "  (not checked — one gh API call per branch; pass --squash-merged to check)"
  echo "   NB: in a squash-merge repo the section above is USUALLY (none) — squashed work is"
  echo "       not an ancestor — so cleanable branches usually appear HERE, not there."
else
gh_init
sq_refs=()
sq_shas=()
sq_prs=()
sq_errors=0
# Iterate over FULL refs. The previous round stripped them back to bare names with sed, which threw
# away the disambiguation `%(refname:short)` performs and handed every later step a name that git
# resolves tag-first — the Critical this round.
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  b="${ref#refs/heads/}"
  # Say WHY a branch never appears. Silently skipping protected names made e.g. `integration-tests`
  # permanently uncleanable with zero visible reason once the boundary set widened.
  if is_protected "$b"; then
    # Only surface PATTERN-protected names. The integration branch and the branch you are standing
    # on are structurally protected and saying so every run is noise; what needed a visible reason
    # is the third kind — e.g. `integration-tests` swept up by the widened boundary set, which
    # otherwise vanishes from every section with nothing explaining why.
    # Printed in APPLY too. Gating it on dry-run hid the reason in the exact invocation run.md:78
    # defines as the standard post-merge command (`--squash-merged … --apply`) — i.e. the fix for
    # "say why a branch never appears" was invisible in the only call that matters.
    if [ "$b" != "$integration" ] && [ "$b" != "$current_branch" ]; then
      echo "  KEEP (protected by name/pattern)  $b"
    fi
    continue
  fi
  is_in_worktree "$b" && continue
  # Anything git already calls merged was handled above. Compared as a FULL ref — see the note on
  # git_merged_refs: the short form is disambiguated to `heads/x` under a same-named tag, so this
  # test used to miss and the branch fell through to the `-D` evidence path.
  list_has "$git_merged_refs" "$ref" && continue
  # Resolve the tip ONCE, from the full ref, and carry it: this sha is what the evidence is about
  # and what authorises the delete.
  sha="$(git rev-parse --verify --quiet "$ref^{commit}" 2>/dev/null || true)"
  [ -n "$sha" ] || continue
  pr="$(merged_pr_for "$sha")"
  # Count PER-BRANCH lookup failures separately. gh_state only records init-level failure;
  # a 403/5xx on an individual branch used to land in the same "no evidence" bucket, so a
  # rate-limited run printed a byte-identical "(none)" to a genuinely clean repo — and a
  # partially failed run silently dropped the branches it could not check. status.md (added in
  # this same PR) tells the model to say "could not verify, not nothing"; it needs this signal
  # to be able to.
  if [ "$pr" = "ERR" ]; then sq_errors=$((sq_errors + 1)); continue; fi
  [ -z "$pr" ] && continue
  sq_refs+=("$ref"); sq_shas+=("$sha"); sq_prs+=("$pr")
done < <(git branch --format='%(refname)' 2>/dev/null)

if [ "${#sq_refs[@]}" -eq 0 ]; then
  if [ "$gh_state" = "unavailable" ]; then
    echo "  (cannot verify — gh not installed/authenticated, or repo not resolvable; branches KEPT)"
  elif [ "$sq_errors" -gt 0 ]; then
    echo "  ($sq_errors branch(es) could not be verified — KEPT. NOT the same as 'nothing to clean'.)"
  else
    echo "  (none)"
  fi
else
  # REPORT ONLY — identical output with or without --apply, because this section never deletes.
  # The sha is printed so the command below is copy-pasteable and so you can see exactly which tip
  # the evidence was gathered for; %q-quoted because `feat/x$(id)` is a legal refname.
  i=0
  while [ "$i" -lt "${#sq_refs[@]}" ]; do
    ref="${sq_refs[$i]}"; sha="${sq_shas[$i]}"; pr="${sq_prs[$i]}"
    printf '  %s  (merged via PR #%s)  tip=%s\n' "${ref#refs/heads/}" "$pr" "${sha:0:12}"
    printf '      delete with:  git branch -D %q\n' "${ref#refs/heads/}"
    i=$((i + 1))
  done
  echo "  ── listed, NOT deleted. Read the PR numbers above, then run the commands you agree with."
  # A partial result must never read as a complete one.
  [ "$sq_errors" -gt 0 ] && echo "  ($sq_errors more branch(es) could not be verified — KEPT; this list is INCOMPLETE)"
fi
fi
echo

# ---- 2. Worktrees: clean + merged only --------------------------------------
echo "## Worktrees (clean + merged only)"
# The PRIMARY worktree, not "whichever worktree you are standing in". `--show-toplevel` returns
# the CURRENT worktree, so running from a linked one — which this skill's own doctrine (one task =
# one worktree) makes the normal case, and status.md runs on every `pilot status` — made §2 skip
# the linked worktree it was standing in and instead print a command to remove the MAIN checkout:
#   remove with:  git worktree remove /path/to/repo  &&  git branch -d primaryfeat
# Harmless as printed output (git refuses both halves), but it is a wrong command handed to a human
# to paste, and on the parent commit — where §2 still executed the removal — it was an attempt to
# delete the main checkout. The first block of `git worktree list --porcelain` is always primary.
main_root="$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -1)"
[ -n "$main_root" ] || main_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
# `git worktree list --porcelain` emits blocks separated by blank lines.
wt_path=""; wt_branch=""
handle_wt() {
  local path="$1" branch="$2"
  [ -z "$path" ] && return
  [ "$path" = "$main_root" ] && return           # never the primary worktree
  local short="${branch#refs/heads/}"
  if [ -z "$branch" ]; then short="(detached)"; fi   # porcelain omits 'branch' line when detached
  # dirty check — never abort on a locked/stale/unreadable worktree; when in doubt, KEEP.
  local dirty rc
  set +e
  dirty="$(git -C "$path" --no-optional-locks status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "  KEEP (worktree status unavailable)  $path  [$short]"
    return
  fi
  if [ "$dirty" != "0" ]; then
    echo "  KEEP (dirty, $dirty changes)  $path  [$short]"
    return
  fi
  # merged check — git-native first, then the same squash evidence section 1b uses.
  # Using ONLY `git branch --merged` here would have left worktrees permanently uncleanable in a
  # squash repo: that predicate returns 0 rows by construction, which is the entire premise of
  # this PR. Missing it meant the fix stopped at loose branches while `SKILL.md`'s own doctrine
  # ("一个 task = 一个分支 = 一个 worktree = 一个 PR") makes the worktree the dominant unit, and
  # `phases/status.md` reports worktree cleanup on every `pilot status`.
  local wt_pr="" via=""
  if [ "$short" = "(detached)" ] || is_protected "$short"; then
    echo "  KEEP (not a merged feature branch)  $path  [$short]"
    return
  fi
  local wt_sha=""
  if list_has "$git_merged_refs" "${branch:-refs/heads/$short}"; then
    via="git"
  elif [ "$squash_merged" != "1" ]; then
    # Same cost gate as section 1b: this ran BEFORE the flag check and was the bulk of the
    # 25-call / 20.6s plain dry-run.
    echo "  KEEP (not merged per git; pass --squash-merged to also check for a squash merge)  $path  [$short]"
    return
  else
    # Resolve via the FULL ref, never the bare short name: with a tag of the same name,
    # `git rev-parse decoy` picks the TAG, so evidence — and the recovery handle — would describe
    # the wrong commit. `$branch` is already refs/heads/<name> here.
    wt_sha="$(git rev-parse --verify --quiet "${branch:-refs/heads/$short}^{commit}" 2>/dev/null || true)"
    if [ -z "$wt_sha" ]; then
      echo "  KEEP (cannot resolve tip — NOT 'unmerged')  $path  [$short]"
      return
    fi
    wt_pr="$(merged_pr_for "$wt_sha")"
    if [ "$wt_pr" = "ERR" ]; then
      echo "  KEEP (could not verify — lookup failed, NOT 'unmerged')  $path  [$short]"
      return
    fi
    if [ -z "$wt_pr" ]; then
      echo "  KEEP (not a merged feature branch)  $path  [$short]"
      return
    fi
    via="squash-PR#$wt_pr"
  fi
  # REPORT ONLY — this section removes nothing, in either mode.
  #
  # `git worktree remove` is a FILESYSTEM delete, and the previous pass stopped at ref writes and
  # never got to it. Two layers each let the same case through: `git status --porcelain` does not
  # list gitignored files, and `git worktree remove` without --force tolerates a tree that has only
  # ignored files in it. Measured: a worktree holding `.env` (SECRET=abc) plus `ignored-stuff/` was
  # deleted outright and the files were unrecoverable — while the header two screens up promised
  # "does not do irreversible deletes at all".
  #
  # It is also newly reachable: on this PR's base, §2 only fired on git-native merge evidence, which
  # a squash repo produces for nothing. Wiring it to GitHub-inferred squash evidence made it fire on
  # every worktree whose PR was merged — and by this skill's own doctrine (one task = one worktree)
  # that is the dominant unit. And run.md/status.md both invoke this unattended, with --apply.
  #
  # The same rule the rest of this file now follows applies here: the hard part (working out which
  # worktrees are merged, with evidence) is automated; the unrecoverable part is printed for a human.
  # This also disposes of the mid-bisect case (`git bisect start` with HEAD still on a branch reports
  # porcelain-clean, and removing the worktree takes BISECT_LOG/BISECT_START with it).
  printf '  %s  [%s]  (%s)\n' "$path" "$short" "$via"
  # `-d` for git-native evidence, `-D` for squash evidence — the same split §1b uses, and for the
  # same reason: after a squash the original tip is not an ancestor, so `git branch -d` CANNOT
  # succeed. Printing `-d` for a squash-merged worktree produced a half-completed paste — the
  # directory removed, then `error: the branch 'x' is not fully merged` — leaving an orphan branch.
  # In a squash repo that was every single line of this section, i.e. the only repo shape this
  # feature exists for.
  if [ "$via" = "git" ]; then
    printf '      remove with:  git worktree remove %q  &&  git branch -d %q\n' "$path" "$short"
  else
    printf '      remove with:  git worktree remove %q  &&  git branch -D %q\n' "$path" "$short"
  fi
  printf '      (check for ignored files first — `git worktree remove` deletes the directory:\n'
  printf '       git -C %q status --porcelain --ignored=matching)\n' "$path"
}
while IFS= read -r line; do
  case "$line" in
    worktree\ *) wt_path="${line#worktree }" ;;
    branch\ *)   wt_branch="${line#branch }" ;;
    "")          handle_wt "$wt_path" "$wt_branch"; wt_path=""; wt_branch="" ;;
  esac
done < <(git worktree list --porcelain 2>/dev/null; echo "")
echo

# ---- 3. Remote branches: NOT handled ---------------------------------------------------------
# This section used to delete on the server; then it was reduced to printing a pasteable
# `git push --delete`. Both were wrong, and the second was wrong in a way that is easy to miss:
# it went safe on the WRONG AXIS. `git fetch --prune` only ran under --apply, so the plain dry-run
# — the mode that looks harmless — built its list from stale remote-tracking refs and printed a
# delete command for a branch a colleague had since pushed to. Reproduced against a real bare
# remote: dry-run printed the command, --apply (which fetches) correctly printed nothing. Pasting
# the dry-run line removed the ref, and a bare repo keeps no reflog for it.
#
# The `|| true` on that fetch made --apply no cure either: with an unreachable remote the refresh
# failed silently and the section printed the same command with no staleness warning.
#
# Once the printed command IS the destructive act, freshness matters MORE, not less. Making that
# correct means refreshing outside --apply, checking the refresh succeeded, and re-verifying each
# candidate rather than just the integration ref — i.e. rebuilding the whole thing this PR just
# spent six rounds learning not to build. GitHub's auto-delete-on-merge already does this job on
# the side where the merge happens. So: not handled here, and said out loud rather than silently
# dropped.
if [ "$do_remote" = "1" ]; then
  echo "## Remote branches ($remote_name)"
  echo "  (not handled — safe-cleanup does not delete or list remote branches)"
  echo "   Enable 'Automatically delete head branches' in the repo settings: GitHub deletes the"
  echo "   head branch when a PR merges, judged server-side where the merge actually happened."
  echo "   Doing it from a clone means judging by possibly-stale refs, and a bare remote keeps no"
  echo "   reflog — the one delete here with no undo at all."
  echo
fi

echo "== done ($mode) =="
