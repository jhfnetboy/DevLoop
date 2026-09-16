#!/usr/bin/env bash
# preflight.sh — run this repo's OWN CI checks locally, and stamp the result.
#
#   preflight.sh [run|check] [--base <branch>]
#     run    (default) execute the checks; on success write a stamp for the current HEAD
#     check  report whether a valid stamp exists for the current HEAD (exit 0 yes / 3 no)
#
# Why: "I'll run CI before opening the PR" is not a control, it is an intention. Every review round
# this repo burned came from opening a PR whose checks had never been executed — including a CI job
# that failed 100% of the time for a reason unrelated to the code under review. The stamp turns the
# intention into state that `git-guard.sh pr-create` can refuse to proceed without.
#
# The stamp is bound to the exact commit (HEAD sha). Amend or add a commit and it is void, because a
# check that passed on different code proves nothing about what you are about to publish.
#
# Checks are discovered, not hardcoded (pilot ships to many repos):
#   1. `.pilot.yml`'s `preflight:` value, if set — the repo's own command, highest priority
#   2. every executable script under scripts/ci/
#   3. `<pkg-manager> run build` when package.json declares a build script
# No checks discovered = FAIL, never "nothing to do": silently passing a repo whose checks we simply
# failed to find is the same fail-open shape this whole layer exists to remove.
set -uo pipefail

sub="run"
base=""
while [ $# -gt 0 ]; do
  case "$1" in
    run|check) sub="$1"; shift ;;
    --base) [ $# -ge 2 ] || { echo "ERROR: --base needs a branch" >&2; exit 2; }; base="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "ERROR: not a git repo" >&2; exit 2; }
cd "$root"
head_sha="$(git rev-parse HEAD 2>/dev/null)"
stamp_file="$(git rev-parse --git-dir)/pilot-preflight"

read_stamp_sha() { [ -f "$stamp_file" ] && sed -n 's/^sha=//p' "$stamp_file" | head -1; }

if [ "$sub" = "check" ]; then
  s="$(read_stamp_sha)"
  if [ -n "$s" ] && [ "$s" = "$head_sha" ]; then
    echo "PREFLIGHT: ok — checks passed for HEAD ${head_sha:0:7}"
    sed -n 's/^grade=/  graded: /p;s/^when=/  ran at: /p' "$stamp_file"
    exit 0
  fi
  if [ -n "$s" ]; then
    echo "PREFLIGHT: STALE — stamp is for ${s:0:7}, HEAD is ${head_sha:0:7}"
    echo "  The code changed since the checks ran. Re-run: preflight.sh run"
  else
    echo "PREFLIGHT: MISSING — this commit's checks have never been run"
    echo "  Run: bash <skill>/scripts/preflight.sh run"
  fi
  exit 3
fi

# ---- discover checks ----------------------------------------------------------------------------
declare -a names=() cmds=()

pf_cmd="$(sed -n 's/^preflight:[[:space:]]*//p' .pilot.yml 2>/dev/null | head -1 | sed 's/^["'"'"']//;s/["'"'"']$//')"
if [ -n "$pf_cmd" ]; then
  names+=(".pilot.yml preflight"); cmds+=("$pf_cmd")
fi

if [ -d scripts/ci ]; then
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    case "$s" in
      *.sh) names+=("$s"); cmds+=("bash $s") ;;
      *.py) names+=("$s"); cmds+=("python3 $s") ;;
    esac
  done < <(find scripts/ci -maxdepth 1 -type f \( -name '*.sh' -o -name '*.py' \) | sort)
fi

if [ -f package.json ] && grep -q '"build"[[:space:]]*:' package.json 2>/dev/null; then
  pm="npm"
  [ -f pnpm-lock.yaml ] && pm="pnpm"
  [ -f yarn.lock ] && pm="yarn"
  names+=("$pm run build"); cmds+=("$pm run build")
fi

if [ "${#cmds[@]}" -eq 0 ]; then
  echo "PREFLIGHT: FAIL — no checks discovered." >&2
  echo "  Looked for: .pilot.yml 'preflight:', scripts/ci/*.{sh,py}, package.json build script." >&2
  echo "  Declare one in .pilot.yml, e.g.:  preflight: make test" >&2
  echo "  (Refusing to pass a repo whose checks we could not find — that would be fail-open.)" >&2
  exit 1
fi

# ---- run them -----------------------------------------------------------------------------------
echo "PREFLIGHT: running ${#cmds[@]} check(s) at HEAD ${head_sha:0:7}"
failed=0
i=0
while [ "$i" -lt "${#cmds[@]}" ]; do
  echo "── ${names[$i]}"
  if ! eval "${cmds[$i]}"; then
    echo "   FAILED: ${names[$i]}" >&2
    failed=$((failed + 1))
  fi
  i=$((i + 1))
done

if [ "$failed" -ne 0 ]; then
  rm -f "$stamp_file"   # a previous pass must not survive a later failure
  echo
  echo "PREFLIGHT: FAIL — $failed of ${#cmds[@]} check(s) failed. No stamp written; PR creation stays blocked." >&2
  exit 1
fi

grade_out="$(bash "$(dirname "$0")/grade-change.sh" ${base:+--base "$base"} --quiet 2>/dev/null | sed -n 's/^GRADE=//p')"
{
  echo "sha=$head_sha"
  echo "when=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "grade=${grade_out:-unknown}"
  echo "checks=${#cmds[@]}"
} > "$stamp_file"

echo
echo "PREFLIGHT: ok — ${#cmds[@]}/${#cmds[@]} passed. Stamped HEAD ${head_sha:0:7} (grade ${grade_out:-unknown})."
