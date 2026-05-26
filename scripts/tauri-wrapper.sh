#!/usr/bin/env bash
# Repo-local tauri wrapper. On macOS, make `pnpm tauri dev` use the pre-launch
# codesign runner by default; all other tauri commands are passed through.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT_DIR/scripts/dev-codesign-runner.sh"
TAURI_BIN="${TAURI_BIN:-tauri}"
if ! command -v "$TAURI_BIN" >/dev/null 2>&1; then
  TAURI_BIN="$ROOT_DIR/node_modules/.bin/tauri"
fi

is_macos() {
  [[ "${WORK_RADAR_FORCE_CODESIGN:-0}" == "1" ]] || [[ "$(uname -s)" == "Darwin" ]]
}

has_runner_arg() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --runner|-r|--runner=*) return 0 ;;
    esac
  done
  return 1
}

if [[ "${1:-}" == "dev" ]] && is_macos && [[ "${WORK_RADAR_UNSIGNED_DEV:-0}" != "1" ]]; then
  shift
  if has_runner_arg "$@"; then
    exec "$TAURI_BIN" dev "$@"
  fi
  exec "$TAURI_BIN" dev --runner "$RUNNER" "$@"
fi

exec "$TAURI_BIN" "$@"
