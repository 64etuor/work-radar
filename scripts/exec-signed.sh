#!/usr/bin/env bash
# cargo 런타임 runner 겸 범용 "서명 후 실행" wrapper.
#
# cargo가 `runner <binary> [args...]` 프로토콜로 부른다(src-tauri/.cargo/config.toml).
# 앱 바이너리(basename == work-radar)만 실행 직전에 고정 dev identity로 서명해,
# tauri-wrapper(pnpm tauri dev)를 우회하는 모든 실행 경로(cargo run, IDE 실행 버튼,
# 맨 tauri dev)에서도 키체인 ACL 신원이 고정된다 — 리빌드마다 macOS 암호를 다시 묻는
# 문제의 근본 원인이 ad-hoc 서명(빌드마다 신원 변경)이기 때문.
#
# cargo test 바이너리(work_radar-<hash> 등) 등 비-앱 실행 파일은 서명/키체인 접근 없이
# 그대로 exec한다(pass-through) — 테스트가 dev keychain에 의존하지 않는다.
#
# 외부 소비자(예: Hermes가 `work-radar --mcp-stdio`를 직접 exec)도 이 스크립트로 감싸면
# 같은 보장을 받는다: scripts/exec-signed.sh /path/to/work-radar --mcp-stdio
#
# escape hatch: WORK_RADAR_UNSIGNED_DEV=1 → 서명 없이 exec(tauri-wrapper와 동일 노브).
set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/dev-codesign-lib.sh
source "$LIB_DIR/dev-codesign-lib.sh"

if (($# == 0)); then
  echo "usage: exec-signed.sh <binary> [args...]" >&2
  exit 64
fi

bin="$1"
shift

if ! is_macos \
  || [[ "${WORK_RADAR_UNSIGNED_DEV:-0}" == "1" ]] \
  || [[ "$(basename "$bin")" != "$BIN_NAME" ]]; then
  exec "$bin" "$@"
fi

sign_binary "$bin"
exec "$bin" "$@"
