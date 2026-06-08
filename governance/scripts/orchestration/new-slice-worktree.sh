#!/usr/bin/env bash
# new-slice-worktree.sh — create an isolated git worktree+branch for a parallel codex slice,
# share governance/node_modules (read-only at test time => no network install in the sandbox),
# and make a scratchpad dir. Prints the worktree path.
# Usage: new-slice-worktree.sh <name> <branch> <base-ref>
set -euo pipefail
NAME="${1:?usage: new-slice-worktree.sh <name> <branch> <base-ref>}"
BRANCH="${2:?branch}"
BASE="${3:?base-ref}"
REPO="${BOULE_REPO:-/Users/davidpark/private_project/work-radar}"
WT_BASE="${BOULE_WT_BASE:-/Users/davidpark/private_project/work-radar-wt}"
NM_SRC="${BOULE_NM_SRC:-$WT_BASE/master-plan/governance/node_modules}"
WT="$WT_BASE/$NAME"

if [ ! -d "$WT" ]; then
  git -C "$REPO" worktree add "$WT" -b "$BRANCH" "$BASE" >/dev/null
fi
[ -e "$WT/governance/node_modules" ] || ln -s "$NM_SRC" "$WT/governance/node_modules"
mkdir -p "$WT/scratchpad"
echo "$WT"
