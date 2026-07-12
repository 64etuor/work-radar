#!/usr/bin/env bash
# 공용 dev codesign 라이브러리 — dev-codesign-runner.sh(tauri --runner 경로)와
# exec-signed.sh(cargo 런타임 runner / 범용 exec wrapper)가 같은 서명 규칙을 공유한다.
#
# 핵심 불변: 서명 identity + identifier가 리빌드 간 고정이어야 macOS 키체인 ACL의
# "항상 허용"이 유지된다 — designated requirement = identifier + certificate leaf
# (회귀 가드: scripts/dev-codesign-dr.test.sh). ad-hoc 서명은 빌드마다 신원이 바뀌어
# 키체인이 매번 암호를 요구한다.
#
# source 전용(직접 실행 아님). set -euo pipefail은 소비 스크립트가 소유한다.

CERT_NAME="${WORK_RADAR_DEV_CERT:-Work Radar Dev}"
IDENTIFIER="${WORK_RADAR_BUNDLE_IDENTIFIER:-co.kr.mirrorless.workradar}"
BIN_NAME="${WORK_RADAR_BIN_NAME:-work-radar}"
KEYCHAIN="${WORK_RADAR_DEV_KEYCHAIN:-$HOME/Library/Keychains/work-radar-dev.keychain-db}"
KEYCHAIN_PASSWORD="${WORK_RADAR_DEV_KEYCHAIN_PASSWORD:-work-radar-dev}"

is_macos() {
  [[ "${WORK_RADAR_FORCE_CODESIGN:-0}" == "1" ]] || [[ "$(uname -s)" == "Darwin" ]]
}

ensure_keychain_in_search_list() {
  local existing=()
  while IFS= read -r line; do
    line="${line#\"}"
    line="${line%\"}"
    line="${line#    }"
    [[ -n "$line" ]] && existing+=("$line")
  done < <(security list-keychains | sed 's/^[[:space:]]*//')

  local item
  for item in "${existing[@]}"; do
    if [[ "$item" == "$KEYCHAIN" ]]; then
      return 0
    fi
  done

  security list-keychains -s "$KEYCHAIN" "${existing[@]}"
}

ensure_keychain_available() {
  if [[ ! -f "$KEYCHAIN" ]]; then
    return 1
  fi
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1 || return 1
  ensure_keychain_in_search_list
}

identity_hash() {
  security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null \
    | awk -v name="\"$CERT_NAME\"" '$0 ~ name { print $2; exit }'
}

print_setup_hint() {
  cat >&2 <<EOF_HINT
❌ 코드서명 identity '$CERT_NAME'를 전용 dev keychain에서 사용할 수 없습니다.

한 번 setup을 실행하세요:
  pnpm tauri:dev:setup

진단:
  security find-identity -p codesigning '$KEYCHAIN'

다른 cert/keychain을 쓰려면 WORK_RADAR_DEV_CERT / WORK_RADAR_DEV_KEYCHAIN으로 override하세요.
EOF_HINT
}

sign_binary() {
  local bin="$1"

  if [[ ! -x "$bin" ]]; then
    echo "❌ 빌드 산출물을 찾지 못했습니다: $bin" >&2
    exit 1
  fi

  if ! ensure_keychain_available; then
    print_setup_hint
    exit 1
  fi

  local signing_id
  signing_id="$(identity_hash)"
  if [[ -z "$signing_id" ]]; then
    print_setup_hint
    exit 1
  fi

  echo "🔏 codesign before launch: $bin" >&2
  # partition-list self-heal: codesign 이 dev 키체인의 개인키를 무인으로 쓰도록 보장한다.
  # 이게 없으면 키체인이 unlock 돼 있어도 codesign 이 키 ACL 때문에 매 실행 키체인 암호를
  # 요구한다(setup 이 한 번 설정하지만 OS 리셋/구버전 setup 이면 풀린다). idempotent·빠름·
  # 실패는 비치명(그 경우 아래 codesign 이 기존과 동일하게 동작 — 회귀 없음).
  security set-key-partition-list \
    -S "apple-tool:,apple:,codesign:" \
    -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1 || true
  if ! codesign --force --sign "$signing_id" --identifier "$IDENTIFIER" "$bin"; then
    echo "❌ codesign failed with identity '$CERT_NAME' ($signing_id)." >&2
    echo "   Run: pnpm tauri:dev:setup" >&2
    echo "   Diagnostic: security find-identity -p codesigning '$KEYCHAIN'" >&2
    exit 1
  fi
}
