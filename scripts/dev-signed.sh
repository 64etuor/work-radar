#!/usr/bin/env bash
# pnpm tauri dev + self-signed codesign 자동 재서명.
#
# WHY: macOS는 키체인 접근 권한을 "이 바이너리(designated requirement)가 접근 가능"
# 단위로 부여한다. dev 빌드는 cargo가 매 rebuild마다 binary를 새로 만들어
# cdhash가 바뀐다 → 키체인 ACL이 매칭 실패 → "Always Allow"가 무효화되어 매번
# 권한 prompt(또는 일부 macOS 버전에선 silent denial). 같은 self-signed cert로
# 재서명하면 keychain ACL의 designated requirement(`Authority == "$CERT_NAME"`)가
# 매칭돼 cdhash가 바뀌어도 권한이 유지된다.
#
# SETUP: docs/reference/dev-codesign-setup.md 참조 (Keychain Access.app에서
# self-signed code signing cert "Work Radar Dev" 1회 생성).
#
# USAGE: `pnpm tauri:dev:signed` (또는 직접 `bash scripts/dev-signed.sh`)
#
# 동작:
#   1. pnpm tauri dev를 background에서 실행.
#   2. 첫 빌드 완료까지 대기(`target/debug/work-radar` 생성).
#   3. binary mtime을 폴링 → 변경 감지 시 즉시 codesign 재실행.
#   4. tauri dev 종료 시 함께 종료.

set -e

CERT_NAME="${WORK_RADAR_DEV_CERT:-Work Radar Dev}"
BIN="src-tauri/target/debug/work-radar"
IDENTIFIER="co.kr.mirrorless.workradar"
POLL_INTERVAL=2

# cert 존재 여부 사전 확인 — 없으면 즉시 실패해 사용자에게 setup 안내.
if ! security find-certificate -c "$CERT_NAME" >/dev/null 2>&1; then
    cat <<EOF >&2
❌ 코드서명 인증서 '$CERT_NAME'가 키체인에 없습니다.

먼저 한 번 생성하세요:
  Keychain Access.app → 메뉴 Keychain Access → Certificate Assistant
  → "Create a Certificate..."
  → Name: $CERT_NAME
     Identity Type: Self Signed Root
     Certificate Type: Code Signing
  → Continue → Create

자세한 절차: docs/reference/dev-codesign-setup.md

(다른 이름을 쓰려면 WORK_RADAR_DEV_CERT 환경변수로 override.)
EOF
    exit 1
fi

cleanup() {
    if [[ -n "${DEV_PID:-}" ]]; then
        kill "$DEV_PID" 2>/dev/null || true
        wait "$DEV_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

echo "🚀 pnpm tauri dev 시작 (background) — 첫 빌드 대기..."
pnpm tauri dev &
DEV_PID=$!

# 첫 빌드 완료까지 대기.
ATTEMPT=0
while [[ ! -x "$BIN" ]]; do
    if ! kill -0 $DEV_PID 2>/dev/null; then
        echo "❌ tauri dev가 빌드 도중 종료됨" >&2
        exit 1
    fi
    sleep 1
    ATTEMPT=$((ATTEMPT + 1))
    if (( ATTEMPT % 30 == 0 )); then
        echo "  ...빌드 중 ($((ATTEMPT))s)"
    fi
done

# 변경 감지 루프 — binary mtime이 바뀔 때마다 재서명.
prev_mtime=""
while kill -0 $DEV_PID 2>/dev/null; do
    if [[ -f "$BIN" ]]; then
        mtime=$(stat -f %m "$BIN" 2>/dev/null || echo "0")
        if [[ "$mtime" != "$prev_mtime" ]]; then
            if codesign --force --sign "$CERT_NAME" --identifier "$IDENTIFIER" "$BIN" 2>/dev/null; then
                echo "🔏 codesigned at $(date +%H:%M:%S) (mtime=$mtime)"
            else
                echo "⚠️  codesign 실패 — cert '$CERT_NAME' trust 설정 확인 필요" >&2
            fi
            prev_mtime=$mtime
        fi
    fi
    sleep $POLL_INTERVAL
done

wait $DEV_PID
