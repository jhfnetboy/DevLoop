#!/usr/bin/env bash
# followups.sh — durable, append-only follow-up ledger for pilot.
#
# WHY: review comments classified "B (real but non-blocking)" — and any non-trivial
# deferred item — must NOT be lost and must NOT be done mid-stream. They are recorded
# here, then batched into ONE cleanup PR AFTER all primary tasks are done. The ledger
# is a COMMITTED file in the repo, so it survives across conversations/loops/machines
# and is visible to humans. GitHub PR comments remain the ultimate backstop.
#
# The ledger is a GitHub-flavored task list (renders on GitHub, greppable in shell):
#   - [ ] FU-3 · B · src=PR#13 · 2026-08-01 · <desc>          (OPEN)
#   - [x] FU-2 · D · src=PR#13 · 2026-08-01 · <desc> · done=PR#20   (DONE)
# Append-only: never delete a line; `done` flips [ ]→[x] in place and appends done=PR#n.
#
# Subcommands:
#   add   --class <A|B|C|D> --source <ref> --desc <text> [--docs-dir <dir>]   -> prints FU-<n>
#   list  [--open] [--docs-dir <dir>]
#   count-open [--docs-dir <dir>]
#   done  <FU-n> --pr <n> [--docs-dir <dir>]
#
# --docs-dir defaults to docs/agent (matches .pilot.yml docs_dir). Ledger = <docs-dir>/followups.md
set -euo pipefail

docs_dir="docs/agent"
cls=""; source_ref=""; desc=""; pr=""; only_open=0
sub="${1:-}"; [ $# -gt 0 ] && shift
pos=""
while [ $# -gt 0 ]; do
  case "$1" in
    --docs-dir) [ $# -ge 2 ] || { echo "ERROR: --docs-dir needs a value" >&2; exit 2; }; docs_dir="$2"; shift 2 ;;
    --class)    [ $# -ge 2 ] || { echo "ERROR: --class needs a value" >&2; exit 2; }; cls="$2"; shift 2 ;;
    --source)   [ $# -ge 2 ] || { echo "ERROR: --source needs a value" >&2; exit 2; }; source_ref="$2"; shift 2 ;;
    --desc)     [ $# -ge 2 ] || { echo "ERROR: --desc needs a value" >&2; exit 2; }; desc="$2"; shift 2 ;;
    --pr)       [ $# -ge 2 ] || { echo "ERROR: --pr needs a value" >&2; exit 2; }; pr="$2"; shift 2 ;;
    --open)     only_open=1; shift ;;
    -*)         echo "ERROR: unknown flag '$1'" >&2; exit 2 ;;
    *)          pos="$1"; shift ;;
  esac
done

ledger="$docs_dir/followups.md"

ensure_ledger() {
  if [ ! -f "$ledger" ]; then
    mkdir -p "$docs_dir"
    {
      echo "# Follow-ups ledger（append-only · 永不删行 · 提交进仓库）"
      echo
      echo "> pilot 的 review triage 把「真问题但不阻塞（B）」和延后项记在这里。"
      echo "> 主线 task 全部完成后，由 \`pilot run\` 批量合成一个 cleanup PR 做掉，逐条标 [x] done=PR#n。"
      echo "> \`- [ ]\`=OPEN，\`- [x]\`=DONE。GitHub PR comment 是永久兜底。"
      echo
    } > "$ledger"
  fi
}

# Highest id used as an ENTRY (not merely mentioned) in one ledger's text on stdin.
#
# Two bugs this shape fixes, both observed 2026-09-05 in one session:
#
#  * counting bare `FU-<n>` anywhere counted PROSE REFERENCES. A line reading "see FU-55" made 55
#    look taken and the next add skipped to 56, leaving a hole nobody could account for. Only an
#    id in entry position (`- [ ] FU-n ·`) is actually allocated.
#  * scanning only the CURRENT branch collided five times. Every collision was against a SIBLING
#    branch that was not merged yet — so `max(branch, main)` would not have caught any of them.
#    The allocator has to see every ref that might already hold an id.
entry_ids() {
  grep -oE '^- \[[ x]\] FU-[0-9]+ ' | grep -oE '[0-9]+'
}

next_id() {
  local n rel repo refs
  { entry_ids < "$ledger" 2>/dev/null || true; } > "$ledger.ids.$$"

  # Every origin/* ref that carries this ledger. Best-effort: outside a git repo, or with no
  # remotes, this contributes nothing and the local maximum still applies.
  repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$repo" ]; then
    rel="$(cd "$repo" && git ls-files --full-name -- "$ledger" 2>/dev/null | head -1)"
    [ -z "$rel" ] && rel="${ledger#"$repo"/}"
    refs="$(git -C "$repo" for-each-ref --format='%(refname)' refs/remotes/origin 2>/dev/null || true)"
    for ref in $refs; do
      git -C "$repo" show "$ref:$rel" 2>/dev/null | entry_ids || true
    done >> "$ledger.ids.$$"
  fi

  n="$(sort -n "$ledger.ids.$$" | tail -1 || true)"
  rm -f "$ledger.ids.$$"
  echo $(( ${n:-0} + 1 ))
}

lock_dir="$ledger.lock"
my_token="$$-$(date +%s)-${RANDOM:-0}"
acquire_lock() {
  # mkdir is atomic → a portable mutex (macOS ships no flock). Serialize read-then-write so
  # concurrent `add`s can't compute the same next id (observed: 6 parallel adds → all FU-1),
  # and a `done` can't race a concurrent write of the ledger.
  mkdir -p "$docs_dir"
  local i=0 steals=0 owner opid
  until mkdir "$lock_dir" 2>/dev/null; do
    i=$((i+1))
    if [ "$i" -gt 600 ]; then      # ~30s of no progress on this lock
      owner="$(cat "$lock_dir/owner" 2>/dev/null || echo)"
      opid="${owner%%-*}"
      steals=$((steals+1))
      # Bounded: don't spin forever if the lock can't be removed / holder stays alive.
      if [ "$steals" -gt 3 ]; then
        echo "ERROR: cannot acquire $lock_dir after 3 attempts (holder alive or lock undeletable) — rm it manually" >&2
        exit 3
      fi
      # Steal ONLY if the recorded holder PID is dead (or none recorded). NEVER steal a LIVE
      # holder's lock — that let two concurrent adds both mint the same FU id. The owner token
      # ($$-ts-rand) also stops our EXIT trap from deleting a lock a later waiter re-acquired.
      if [ -z "$owner" ] || ! kill -0 "$opid" 2>/dev/null; then
        echo "followups: stealing stale lock $lock_dir (dead owner '${owner:-none}')" >&2
        rm -rf "$lock_dir" 2>/dev/null || true
      fi
      i=0
    fi
    sleep 0.05
  done
  printf '%s' "$my_token" > "$lock_dir/owner"
  trap 'if [ "$(cat "$lock_dir/owner" 2>/dev/null || echo)" = "$my_token" ]; then rm -rf "$lock_dir" 2>/dev/null || true; fi' EXIT
}

case "$sub" in
  add)
    [ -n "$cls" ] && [ -n "$desc" ] || { echo "usage: followups.sh add --class <A|B|C|D> --source <ref> --desc <text>" >&2; exit 2; }
    case "$cls" in A|B|C|D) : ;; *) echo "ERROR: --class must be A|B|C|D" >&2; exit 2 ;; esac
    acquire_lock          # serialize next_id-then-append so parallel adds get distinct ids
    ensure_ledger
    id="FU-$(next_id)"
    day="$(date +%F)"
    # strip newlines from BOTH src and desc — a multi-line value would forge an extra ledger line
    # (poisoning next_id) or truncate this record.
    src="$(printf '%s' "${source_ref:-manual}" | tr '\n' ' ' | tr -d '\r')"
    desc_clean="$(printf '%s' "$desc" | tr '\n' ' ' | tr -d '\r')"
    printf -- '- [ ] %s · %s · src=%s · %s · %s\n' "$id" "$cls" "$src" "$day" "$desc_clean" >> "$ledger"
    echo "$id"
    ;;
  list)
    [ -f "$ledger" ] || { echo "(no ledger at $ledger)"; exit 0; }
    if [ "$only_open" = "1" ]; then
      grep -E '^- \[ \] FU-' "$ledger" || echo "(no open follow-ups)"
    else
      grep -E '^- \[[ x]\] FU-' "$ledger" || echo "(ledger empty)"
    fi
    ;;
  count-open)
    # grep -c prints "0" AND exits 1 on no-match — a bare `|| echo 0` would print "0\n0" and
    # break the numeric stop-condition gate. Capture, then emit exactly one number.
    if [ -f "$ledger" ]; then c="$(grep -cE '^- \[ \] FU-' "$ledger" || true)"; echo "${c:-0}"; else echo 0; fi
    ;;
  done)
    [ -n "$pos" ] || { echo "usage: followups.sh done <FU-n> --pr <n>" >&2; exit 2; }
    [ -n "$pr" ] || { echo "ERROR: done requires --pr <n>" >&2; exit 2; }
    # Validate --pr as digits: it's passed via `awk -v pr=...` (which does escape-processing), so a
    # newline/backslash value could inject a second forged line into the ledger during the rewrite.
    [[ "$pr" =~ ^[0-9]+$ ]] || { echo "ERROR: --pr must be a number" >&2; exit 2; }
    [ -f "$ledger" ] || { echo "ERROR: no ledger at $ledger" >&2; exit 2; }
    # Regex (not a `case` glob): a glob like FU-[0-9]* lets metacharacters through, and $pos is
    # interpolated straight into the awk ERE below — `done 'FU-1.*'` would mass-close FU-1/10/11/…
    [[ "$pos" =~ ^FU-[0-9]+$ ]] || { echo "ERROR: id must look like FU-<n> (digits only)" >&2; exit 2; }
    acquire_lock          # serialize read-modify-write of the ledger against concurrent add/done
    tmp="$ledger.tmp.$$"
    awk -v id="$pos" -v pr="$pr" '
      {
        # exact-token match: line has "] <id> ·" (the " · " boundary avoids FU-1 matching FU-12)
        if ($0 ~ ("^- \\[ \\] " id " · ")) {
          sub(/^- \[ \]/, "- [x]", $0)
          $0 = $0 " · done=PR#" pr
        }
        print
      }
    ' "$ledger" > "$tmp"
    if cmp -s "$ledger" "$tmp"; then rm -f "$tmp"; echo "ERROR: $pos not found or already done" >&2; exit 1; fi
    mv "$tmp" "$ledger"
    echo "marked $pos done (PR#$pr)"
    ;;
  *)
    echo "followups.sh: add | list [--open] | count-open | done <FU-n> --pr <n>" >&2
    exit 2 ;;
esac
