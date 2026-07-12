#!/usr/bin/env bash
# 실키체인 DR(designated requirement) 안정성 회귀 테스트.
#
# "항상 허용"이 리빌드 후에도 유지되려면, 내용이 다른 두 바이너리가 같은 identity/identifier로
# 서명됐을 때 DR이 동일해야 하고(키체인 ACL이 DR로 앱을 식별), DR이 cert-leaf 기반이어야
# 한다(cdhash 기반이면 빌드마다 바뀌어 암호 프롬프트가 재발 — 이 리포트가 이 트랙의 발단).
#
# 전용 dev keychain/identity가 없는 환경(신규 클론·CI·타 OS)에서는 SKIP(exit 0) —
# mock이 아닌 실제 codesign/키체인을 검증하는 macOS 로컬 전용 테스트다.
set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/dev-codesign-lib.sh
source "$LIB_DIR/dev-codesign-lib.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "SKIP: macOS 아님"
  exit 0
fi
if ! ensure_keychain_available; then
  echo "SKIP: 전용 dev keychain 없음 — pnpm tauri:dev:setup 후 재실행"
  exit 0
fi
signing_id="$(identity_hash)"
if [[ -z "$signing_id" ]]; then
  echo "SKIP: '$CERT_NAME' identity 없음 — pnpm tauri:dev:setup 후 재실행"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp /usr/bin/true "$TMP/a"
cp /usr/bin/false "$TMP/b"

security set-key-partition-list \
  -S "apple-tool:,apple:,codesign:" \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1 || true
codesign --force --sign "$signing_id" --identifier "$IDENTIFIER" "$TMP/a"
codesign --force --sign "$signing_id" --identifier "$IDENTIFIER" "$TMP/b"

ra="$(codesign -d -r- "$TMP/a" 2>&1 | grep '^designated')"
rb="$(codesign -d -r- "$TMP/b" 2>&1 | grep '^designated')"

if [[ -z "$ra" || "$ra" != "$rb" ]]; then
  echo "FAIL: 서로 다른 바이너리의 DR이 불일치 — 키체인 '항상 허용'이 리빌드마다 무효화된다" >&2
  echo "  a: $ra" >&2
  echo "  b: $rb" >&2
  exit 1
fi
if [[ "$ra" != *"certificate leaf"* ]]; then
  echo "FAIL: DR이 cert-leaf 기반이 아님(cdhash 추정 — 빌드마다 신원 변경): $ra" >&2
  exit 1
fi
if [[ "$ra" != *"$IDENTIFIER"* ]]; then
  echo "FAIL: DR에 identifier '$IDENTIFIER' 부재: $ra" >&2
  exit 1
fi

echo "dev-codesign DR stability passed: $ra"
