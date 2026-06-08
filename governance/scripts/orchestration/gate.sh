#!/usr/bin/env bash
# gate.sh — run the governance gates in a worktree, emit ONE compact JSON verdict line.
# Token-saving: the orchestrator reads one line instead of ~600 lines of vitest output.
# Usage: gate.sh <worktree-dir>
# Exit 0 iff tsc==0 AND vitest==0 AND no app drift (src/bindings.ts, src-tauri/migrations).
set -uo pipefail
WT="${1:?usage: gate.sh <worktree-dir>}"
export PATH="$HOME/.cargo/bin:$PATH"
cd "$WT/governance" 2>/dev/null || { echo '{"error":"no governance dir"}'; exit 2; }

tsc_out=$(pnpm exec tsc --noEmit 2>&1); tsc_rc=$?
vitest_out=$(pnpm exec vitest run 2>&1); vitest_rc=$?

tests_line=$(printf '%s\n' "$vitest_out" | grep -E 'Tests[[:space:]]+[0-9]' | tail -1)
files_line=$(printf '%s\n' "$vitest_out" | grep -E 'Test Files[[:space:]]+[0-9]' | tail -1)
pass=$(printf '%s' "$tests_line"  | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | head -1)
fail=$(printf '%s' "$tests_line"  | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' | head -1)
files=$(printf '%s' "$files_line" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | head -1)
pass=${pass:-0}; fail=${fail:-0}; files=${files:-0}

drift=$(git -C "$WT" status --porcelain -- src/bindings.ts src-tauri/migrations 2>/dev/null | wc -l | tr -d ' ')

printf '{"tsc_rc":%d,"vitest_rc":%d,"pass":%d,"fail":%d,"files":%d,"app_drift":%d}\n' \
  "$tsc_rc" "$vitest_rc" "$pass" "$fail" "$files" "$drift"

[ "$tsc_rc" = 0 ] && [ "$vitest_rc" = 0 ] && [ "$drift" = 0 ]
