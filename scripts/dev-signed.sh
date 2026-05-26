#!/usr/bin/env bash
# Backwards-compatible entrypoint for signed dev. The default `pnpm tauri dev`
# path is also signed via scripts/tauri-wrapper.sh; this script remains as an
# explicit, discoverable alias.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_BIN="${TAURI_BIN:-tauri}"
if ! command -v "$TAURI_BIN" >/dev/null 2>&1; then
  TAURI_BIN="$ROOT_DIR/node_modules/.bin/tauri"
fi

exec "$TAURI_BIN" dev --runner "$ROOT_DIR/scripts/dev-codesign-runner.sh" "$@"
