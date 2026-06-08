#!/usr/bin/env bash
# run-slice.sh — dispatch a codex executor for ONE slice, under a clean hooks-free CODEX_HOME
# (so the operator's global OMX/cmux hooks don't hijack the session), tee output to the
# worktree scratchpad, then emit the compact gate verdict. Designed to be run in the background
# by the orchestrator (which is then notified on completion).
# Usage: run-slice.sh <phase-id> <worktree-dir> <brief-file>
set -uo pipefail
PHASE="${1:?usage: run-slice.sh <phase-id> <worktree-dir> <brief-file>}"
WT="${2:?worktree-dir}"
BRIEF="${3:?brief-file}"
HERE="$(cd "$(dirname "$0")" && pwd)"

CH="/tmp/boule-codex-home-$PHASE"
mkdir -p "$CH"
printf 'plugin_hooks = false\nnotify = []\n' > "$CH/config.toml"
rm -f "$CH/hooks.json"
[ -e "$CH/auth.json" ] || ln -s "$HOME/.codex/auth.json" "$CH/auth.json"

mkdir -p "$WT/scratchpad"
OUT="$WT/scratchpad/$PHASE-out.txt"
echo "[$PHASE] codex start $(date)" | tee "$OUT"
CODEX_HOME="$CH" codex exec "$(cat "$BRIEF")" -C "$WT" -s workspace-write \
  -c 'approval_policy="never"' -c 'model_reasoning_effort="high"' < /dev/null 2>&1 | tee -a "$OUT"
rc=${PIPESTATUS[0]}
echo "[$PHASE] codex exit $rc $(date)" | tee -a "$OUT"
echo "[$PHASE] GATE:"
bash "$HERE/gate.sh" "$WT"
