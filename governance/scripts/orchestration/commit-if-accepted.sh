#!/usr/bin/env bash
# commit-if-accepted.sh — commit governance/ in a worktree ONLY IF (a) a separate critic verdict
# file says ACCEPT with no blockers, AND (b) gates are green. Enforces INVARIANT #1 / no-self-approve:
# refuses to commit on green gates alone — an external reviewer ACCEPT is mandatory. Never pushes.
# Usage: commit-if-accepted.sh <worktree-dir> <verdict-file> <commit-msg-file>
set -uo pipefail
WT="${1:?usage: commit-if-accepted.sh <worktree> <verdict-file> <msg-file>}"
VERDICT="${2:?verdict-file}"
MSG="${3:?commit-msg-file}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

[ -f "$VERDICT" ] || { echo "REFUSE: verdict file missing ($VERDICT)"; exit 1; }
grep -qiE 'REQUEST-CHANGES|BLOCKER|REJECT' "$VERDICT" && { echo "REFUSE: verdict has blockers/changes"; exit 1; }
grep -qiE '\bACCEPT\b' "$VERDICT" || { echo "REFUSE: verdict is not ACCEPT"; exit 1; }

g=$(bash "$HERE/gate.sh" "$WT"); echo "GATE: $g"
echo "$g" | grep -q '"tsc_rc":0' && echo "$g" | grep -q '"vitest_rc":0' && echo "$g" | grep -q '"app_drift":0' \
  || { echo "REFUSE: gates not green"; exit 1; }

cd "$WT"
git add governance/
git commit -F "$MSG" >/dev/null && echo "COMMITTED: $(git rev-parse --short HEAD)" && git log --oneline -1
