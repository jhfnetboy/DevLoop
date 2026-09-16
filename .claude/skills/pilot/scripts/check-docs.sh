#!/usr/bin/env bash
# check-docs.sh — gate: is the planning layer complete enough to run UNATTENDED?
#
#   bash scripts/check-docs.sh [--docs-dir docs/agent] [--strict|--minimal] [--no-config]
#
# Repos whose planning lives elsewhere (backlog.md, an issue tracker, …) declare it in .pilot.yml:
#
#     planning_source: external      # docs (default) | external
#
# and this gate then checks NOTHING and says so, instead of reporting a false NOT-ready. See the
# long note at the planning_source block for why that is a declaration rather than a check.
#
# Unattended delivery means nobody is around to answer "what did you mean here?".
# Every gap in the planning layer becomes a guess the model makes alone at 3am, so this
# gate is FAIL-CLOSED: missing or placeholder-only docs stop `run` before it writes code.
#
#   --strict  (default) ALL 7 docs must exist and be filled in. Use for unattended runs.
#   --minimal roadmap + tasks + progress only — the bare minimum `run` needs to act at all.
#             Use when a human is watching and can answer questions.
#
# A doc counts as MISSING when absent, and as EMPTY when it still looks like the raw
# template: under MIN_BYTES of content, or every remaining line is a heading/placeholder
# (`<...>` angle-bracket slots the templates ship with). Shipping a template with the
# slots unfilled is worse than no doc — it reads as answered when it isn't.
#
# Exit: 0 = ready, 1 = gaps found (list printed), 2 = usage error.
set -uo pipefail

docs_dir="docs/agent"
mode="strict"
# ~120 bytes ≈ 40 Chinese chars ≈ two real sentences.
#
# Measured scores of the SHIPPED pristine templates (scaffolding text that carries no `<...>`
# slot still counts): research=42 acceptance=73 architecture=0 spec=26 roadmap=0 tasks=99
# progress=32. So 120 currently blocks all seven — but the margin on tasks.md is only 21 bytes.
# Raise this floor, don't lower it, and re-measure if the templates gain prose.
#
# Kept modest because progress.md is legitimately terse — too high a bar would block a run over
# a doc that IS answered.
MIN_BYTES="${PILOT_DOC_MIN_BYTES:-120}"

# Validate the knob BEFORE any comparison uses it. `[ x -lt abc ]` is a runtime ERROR, not a
# false comparison; under `set -uo pipefail` (no -e) an error inside an `elif` condition merely
# makes that branch false, so every doc would fall through to the `else` and be counted OK —
# the gate would report "ready" on seven blank templates. A gate that fails OPEN is worse than
# no gate, because it reports safety it did not verify. Verified: PILOT_DOC_MIN_BYTES=abc (or
# a typo like "120B") previously yielded ok=7/7 + exit 0 on a directory of untouched templates.
case "$MIN_BYTES" in
  ''|*[!0-9]*)
    echo "ERROR: PILOT_DOC_MIN_BYTES must be a non-negative integer, got: '$MIN_BYTES'" >&2
    exit 2 ;;
esac
# 0 would pass any file that merely exists — that is disabling the gate, not tuning it. If you
# genuinely want no gate, don't run this script; don't silently neuter it via an env var.
if [ "$MIN_BYTES" -eq 0 ]; then
  echo "ERROR: PILOT_DOC_MIN_BYTES=0 disables the gate (any existing file would pass). Refusing." >&2
  exit 2
fi

read_config=1
while [ $# -gt 0 ]; do
  case "$1" in
    --docs-dir) [ $# -ge 2 ] || { echo "ERROR: --docs-dir needs a path" >&2; exit 2; }; docs_dir="$2"; shift 2 ;;
    --strict)  mode="strict";  shift ;;
    --minimal) mode="minimal"; shift ;;
    # Ignore .pilot.yml entirely. Used by scripts/ci/check-docs-gate.sh, which tests this gate's own
    # logic against fixture directories from the repo root — without this, a repo that declares
    # `planning_source: external` would make every one of those assertions exit 0 while claiming to
    # test something else.
    --no-config) read_config=0; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---- planning_source: where does this repo's planning actually live? --------------------------
#
# Default (absent, or `docs`): the seven files under docs_dir, checked as below.
#
# `external`: the repo plans in backlog.md / an issue tracker / anywhere else. The gate then
# verifies NOTHING and says so, loudly, instead of reporting a false NOT-ready. Measured: Brood
# plans in backlog/ (4 milestones, 49 tasks with acceptance criteria, 2 ADRs) and this gate scored
# it 0/7 — while plan.md §A.3 tells you not to re-create planning that already exists. Both rules
# could not be obeyed at once.
#
# WHY A DECLARATION AND NOT A CHECK. The obvious fix is to let the repo point the gate at its real
# planning source and have the gate verify THAT. I built it: `planning_requires: [backlog/tasks]`,
# with the same content bar. Two review rounds found five defects and every one of them was in the
# path validation, not in the thing it was meant to solve — the repo root spelled `.//`, `./.`,
# `././`; `.GIT` slipping past a `.git` string match on a case-insensitive filesystem; a symlinked
# FILE pointing out of the repo; entries resolved against the CWD while the config was found from
# the toplevel; and my own "declared but unparseable" abort killing a perfectly valid zero-indent
# YAML list. A knob that says "check this path instead" has to be robust against every way a path
# can lie, and that is a much bigger problem than the one being solved.
#
# A declaration has no criterion to subvert, because it has no criterion. The gate exists so nobody
# starts an UNATTENDED run against an incomplete plan; a human writing `external` in the repo's own
# config is taking that responsibility explicitly, which is the same thing the gate was asking for.
planning_source=""
if [ "$read_config" = "1" ]; then
  _top="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
  for _f in "$_top/.pilot.yml" "$_top/.repo-pilot.yml"; do
    [ -f "$_f" ] || continue
    # Require a REAL separating space, and strip only MATCHED quotes.
    #
    # The declaration removes the criterion, but not the 6 lines that read it — and those lines had
    # the same fail-OPEN shape as the validator they replaced, one size smaller. All three of these
    # were read as `external` (i.e. gate off), and none of them is what it looks like:
    #   planning_source:external      → to YAML this is a plain SCALAR STRING; there is no key here
    #   planning_source:<TAB>external → yaml.safe_load raises ScannerError
    #   planning_source: ex"ter"nal   → the value IS `ex"ter"nal`; it must hit the `*)` refuse arm,
    #                                   but `tr -d "\"'"` mangled it into `external`
    # `[[:space:]]\{1,\}` makes the first two miss the pattern entirely, so they fall back to
    # checking the docs (fail-CLOSED); the paired-quote strip leaves the third as `ex"ter"nal`,
    # which the case below refuses instead of guessing.
    # A literal SPACE, not `[[:space:]]` — that class includes TAB, and YAML does not: a tab after
    # the colon is a ScannerError, not a value. Matching it would have accepted a file no YAML
    # parser will read.
    planning_source="$(sed -n 's/^planning_source: \{1,\}//p' "$_f" | head -1 \
      | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' \
            -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
    break
  done
fi

case "$planning_source" in
  ''|docs) : ;;   # default: check the seven docs, exactly as before
  external)
    echo "PILOT_DOCS: mode=$mode source=external (declared in .pilot.yml) — NOTHING WAS CHECKED"
    echo "  This repo declares its planning lives outside '$docs_dir'. This gate verified nothing:"
    echo "  it did not look at the planning source and cannot vouch for it."
    echo "  Report it that way. Do NOT say 'planning verified' or 'ready' — say the repo declares"
    echo "  its planning is external, and that starting an unattended run asserts it is complete."
    exit 0 ;;
  *)
    echo "ERROR: .pilot.yml has planning_source: '$planning_source' — expected 'docs' or 'external'." >&2
    echo "  Refusing rather than guessing: guessing 'docs' would report a false NOT-ready, and" >&2
    echo "  guessing 'external' would wave through a repo nobody vouched for." >&2
    exit 2 ;;
esac

# Ordered by the information flow in plan.md: research → acceptance → architecture+spec
# → roadmap → tasks → progress. Earlier docs constrain later ones, so report them in order.
STRICT_DOCS="research acceptance architecture spec roadmap tasks progress"
MINIMAL_DOCS="roadmap tasks progress"
[ "$mode" = "minimal" ] && DOCS="$MINIMAL_DOCS" || DOCS="$STRICT_DOCS"

# Real content = lines that are not blank / heading / blockquote / table-rule / hrule
# AND contain NO `<...>` placeholder anywhere on the line.
#
# The "anywhere on the line" part is the whole trick. The templates put their slots INLINE
# ("目标：<这个阶段要达成的业务价值>", "- **F1.1 <Feature名>** — <覆盖什么>"), so a filter
# that only drops whole-line `<...>` slots lets a pristine, 100%-unfilled template through
# as "ready" — the exact failure this gate exists to prevent. A line still carrying a slot
# is by definition unanswered, so it contributes nothing. Filling a doc means writing lines
# with no slots left, which is precisely what gets counted here.
real_content_bytes() {
  sed -e 's/^[[:space:]]*//' "$1" 2>/dev/null \
    | grep -vE '^$|^#|^>|^-{3,}$|^\|[[:space:]:|-]*\|?$' \
    | grep -vE '<[^>]*>' \
    | wc -c | tr -d ' '
}

missing=""; empty=""; ok=0
for d in $DOCS; do
  f="$docs_dir/$d.md"
  if [ ! -f "$f" ]; then
    missing="$missing $d"
    continue
  fi
  bytes="$(real_content_bytes "$f")"
  # Treat an unreadable measurement as EMPTY, never as OK. Same reasoning as the MIN_BYTES
  # validation above: if the count is not a plain integer the comparison would error, the
  # branch would read false, and the doc would be silently counted as filled in.
  case "$bytes" in ''|*[!0-9]*) empty="$empty $d"; continue ;; esac
  if [ "$bytes" -lt "$MIN_BYTES" ]; then
    empty="$empty $d"
  else
    ok=$((ok + 1))
  fi
done

total=$(echo $DOCS | wc -w | tr -d ' ')
# Echo the effective threshold on EVERY outcome, including success. PILOT_DOC_MIN_BYTES can
# weaken the gate from outside the repo; if the passing line never showed it, a loosened gate
# would leave no trace in the run's report.
echo "PILOT_DOCS: mode=$mode dir=$docs_dir min_bytes=$MIN_BYTES ok=$ok/$total"

if [ -z "$missing" ] && [ -z "$empty" ]; then
  echo "PILOT_DOCS: ready — planning layer complete, safe to run unattended."
  exit 0
fi

[ -n "$missing" ] && { echo "  MISSING (file absent):"; for d in $missing; do echo "    - $docs_dir/$d.md"; done; }
[ -n "$empty" ]   && { echo "  EMPTY (still the template / under ${MIN_BYTES}B of real content):"; for d in $empty; do echo "    - $docs_dir/$d.md"; done; }
echo "PILOT_DOCS: NOT ready — run \`pilot plan\` to fill these in before an unattended run."
echo "  (a human-supervised run can proceed with --minimal: roadmap + tasks + progress)"
exit 1
