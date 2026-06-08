#!/usr/bin/env bash
# merge-slice.sh — attempt a clean merge of <branch> into the CURRENT worktree's branch.
# On conflict: abort and report the conflicting files (the orchestrator/model resolves manually).
# Never pushes. Run from the integration worktree (e.g. master-plan).
# Usage: merge-slice.sh <branch>
set -uo pipefail
BR="${1:?usage: merge-slice.sh <branch>}"
export PATH="$HOME/.cargo/bin:$PATH"

if git merge --no-ff --no-edit "$BR" >/dev/null 2>&1; then
  printf '{"merged":true,"branch":"%s","head":"%s"}\n' "$BR" "$(git rev-parse --short HEAD)"
else
  conflicts=$(git diff --name-only --diff-filter=U | paste -sd, - 2>/dev/null)
  git merge --abort 2>/dev/null || true
  printf '{"merged":false,"branch":"%s","conflicts":"%s"}\n' "$BR" "$conflicts"
  exit 1
fi
