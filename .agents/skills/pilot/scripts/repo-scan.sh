#!/usr/bin/env bash
# repo-scan.sh — read-only snapshot of a repo's git state for pilot `status`.
# Prints a compact, machine-friendly block. Never mutates anything.
#
# Usage: repo-scan.sh [--integration <branch>]
#   --integration <branch>  Branch that PRs merge into (for "merged" detection).
#                           Defaults to the value guessed from origin/HEAD, else main.
set -euo pipefail
export GIT_OPTIONAL_LOCKS=0   # keep this script strictly read-only (no index refresh writes)

integration=""
while [ $# -gt 0 ]; do
  case "$1" in
    --integration) integration="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "PILOT_SCAN: not-a-git-repo"
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel)"
repo_name="$(basename "$repo_root")"
current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo DETACHED)"

# Guess integration branch if not supplied.
if [ -z "$integration" ]; then
  if git symbolic-ref --quiet refs/remotes/origin/HEAD >/dev/null 2>&1; then
    integration="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  fi
fi
if [ -z "$integration" ]; then
  for cand in main master; do
    if git show-ref --verify --quiet "refs/heads/$cand"; then integration="$cand"; break; fi
  done
fi
[ -z "$integration" ] && integration="$current_branch"

# Dirty working tree. dirty = tracked changes only (staged + unstaged), so it is
# DISJOINT from untracked below — otherwise a lone new file shows as dirty=1 +
# untracked=1 and reads like two separate problems. Untracked is reported on its
# own line so callers can judge "working tree has uncommitted *tracked* edits"
# (the signal run/ cares about) without the untracked superset inflating it.
dirty_count="$(git status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')"
untracked_count="$(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')"

# Branch counts.
local_count="$(git for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null | wc -l | tr -d ' ')"
remote_count="$(git for-each-ref --format='%(refname:short)' refs/remotes 2>/dev/null | grep -v 'HEAD$' | wc -l | tr -d ' ')"
worktree_count="$(git worktree list 2>/dev/null | wc -l | tr -d ' ')"

# Local branches merged into integration (candidates for cleanup), excluding protected/current.
merged_branches=""
if git show-ref --verify --quiet "refs/heads/$integration"; then
  while IFS= read -r b; do
    b="$(echo "$b" | sed 's/^[* +] *//')"
    [ -z "$b" ] && continue
    case "$b" in
      main|master|develop|preview|integration|release|hotfix|release/*|hotfix/*|"$integration"|"$current_branch") continue ;;
    esac
    merged_branches="${merged_branches}${b}\n"
  done < <(git branch --merged "$integration" 2>/dev/null)
fi
merged_count="$(printf "%b" "$merged_branches" | grep -c . || true)"

# Ahead/behind of integration for current branch.
ahead_behind="n/a"
if git show-ref --verify --quiet "refs/heads/$integration" && [ "$current_branch" != "$integration" ]; then
  set +e
  counts="$(git rev-list --left-right --count "$integration...$current_branch" 2>/dev/null)"
  set -e
  [ -n "$counts" ] && ahead_behind="$(echo "$counts" | awk '{print "behind="$1" ahead="$2}')"
fi

echo "PILOT_SCAN: ok"
echo "repo=$repo_name"
echo "root=$repo_root"
echo "current_branch=$current_branch"
echo "integration_branch=$integration"
echo "current_vs_integration=$ahead_behind"
echo "dirty_files=$dirty_count"
echo "untracked_files=$untracked_count"
echo "local_branches=$local_count"
echo "remote_branches=$remote_count"
echo "worktrees=$worktree_count"
echo "merged_into_integration=$merged_count"
if [ "$merged_count" != "0" ]; then
  echo "--- merged (cleanup candidates) ---"
  printf "%b" "$merged_branches" | grep . || true
fi
echo "--- worktrees ---"
git worktree list 2>/dev/null || true
