#!/usr/bin/env bash
# 1회 실행: Work Radar 전용 dev keychain에 self-signed code signing identity를 만든다.
#
# WHY: login keychain에 만든 self-signed cert는 trust/private-key ACL 상태가 꼬이면
# `find-identity`에는 보이는데 `codesign`은 "item not found"로 실패할 수 있다. 전용 keychain은
# 스크립트가 사용자 제공 비밀번호로 unlock하고 search-list/trust를 관리해 dev 재빌드 서명이 안정적이다.
#
# USAGE: `WORK_RADAR_DEV_KEYCHAIN_PASSWORD='<user-chosen-password>' pnpm tauri:dev:setup`
#
# IDEMPOTENT: 기존 전용 keychain identity도 실제 codesign smoke test로 검증하고, 실패하면 재생성한다.

set -euo pipefail

CERT_NAME="${WORK_RADAR_DEV_CERT:-Work Radar Dev}"
IDENTIFIER="${WORK_RADAR_BUNDLE_IDENTIFIER:-co.kr.mirrorless.workradar}"
KEYCHAIN="${WORK_RADAR_DEV_KEYCHAIN:-$HOME/Library/Keychains/work-radar-dev.keychain-db}"
KEYCHAIN_PASSWORD="${WORK_RADAR_DEV_KEYCHAIN_PASSWORD:-}"
DAYS=3650

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "❌ macOS 전용 스크립트입니다." >&2
    exit 1
fi

if [[ -z "$KEYCHAIN_PASSWORD" ]]; then
    echo "❌ WORK_RADAR_DEV_KEYCHAIN_PASSWORD에 사용자 선택 비밀번호를 설정하세요." >&2
    echo "   예: WORK_RADAR_DEV_KEYCHAIN_PASSWORD='<user-chosen-password>' pnpm tauri:dev:setup" >&2
    exit 1
fi

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

ensure_dev_keychain() {
    mkdir -p "$(dirname "$KEYCHAIN")"
    if [[ ! -f "$KEYCHAIN" ]]; then
        echo "🔐 전용 dev keychain 생성: $KEYCHAIN"
        security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
    fi

    if ! security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1; then
        echo "❌ 전용 dev keychain unlock 실패: $KEYCHAIN" >&2
        echo "   비밀번호가 바뀐 오래된 keychain일 수 있습니다. 삭제 후 재시도:" >&2
        echo "   security delete-keychain '$KEYCHAIN'" >&2
        echo "   WORK_RADAR_DEV_KEYCHAIN_PASSWORD='<user-chosen-password>' pnpm tauri:dev:setup" >&2
        exit 1
    fi

    # 6시간 자동 잠금 지연. dev session 중 반복 prompt 방지.
    security set-keychain-settings -lut 21600 "$KEYCHAIN"
    ensure_keychain_in_search_list
}

identity_hash() {
    security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null \
        | awk -v name="\"$CERT_NAME\"" '$0 ~ name { print $2; exit }'
}

sign_smoke_test() {
    local signing_id="$1"
    local tmpdir log target
    tmpdir="$(mktemp -d)"
    log="$tmpdir/codesign.log"
    target="$tmpdir/true"
    cp /usr/bin/true "$target"
    # 중요: --keychain을 주지 않는다. codesign은 search list에 들어간 keychain에서 hash를 찾는다.
    # `--keychain <path>`는 self-signed/custom keychain에서 item-not-found를 유발할 수 있었다.
    if codesign --force --sign "$signing_id" --identifier "$IDENTIFIER" "$target" >"$log" 2>&1; then
        rm -rf "$tmpdir"
        return 0
    fi
    echo "--- codesign smoke 실패 로그 ---" >&2
    cat "$log" >&2
    echo "------------------------------" >&2
    rm -rf "$tmpdir"
    return 1
}

trust_certificate() {
    local cert_path="$1"
    echo "🔐 codesign trust 등록 중..."
    security add-trusted-cert \
        -r trustRoot \
        -p codeSign \
        -k "$KEYCHAIN" \
        "$cert_path"
}

cleanup_existing_identity() {
    echo "🧹 기존 전용 identity 정리 중..."
    security delete-identity -c "$CERT_NAME" -t "$KEYCHAIN" >/dev/null 2>&1 || true
    security delete-certificate -c "$CERT_NAME" "$KEYCHAIN" >/dev/null 2>&1 || true
}

finish_success() {
    local hash="$1"
    echo ""
    echo "✅ 완료 — '$CERT_NAME' codesign smoke test 통과"
    echo ""
    echo "전용 keychain: $KEYCHAIN"
    echo "identity hash: $hash"
    echo ""
    echo "확인:"
    echo "  security find-identity -p codesigning '$KEYCHAIN'"
    echo ""
    echo "이제 dev 부팅:"
    echo "  WORK_RADAR_DEV_KEYCHAIN_PASSWORD='<user-chosen-password>' pnpm tauri dev"
}

ensure_dev_keychain

existing_hash="$(identity_hash || true)"
if [[ -n "$existing_hash" ]]; then
    echo "✓ 전용 keychain identity 후보 발견: $existing_hash"
    if sign_smoke_test "$existing_hash"; then
        finish_success "$existing_hash"
        exit 0
    fi
    echo "⚠️  기존 전용 identity가 실제 codesign에 실패합니다. 재생성합니다."
    cleanup_existing_identity
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "🔧 self-signed code signing cert 생성 중 ('$CERT_NAME')..."

openssl req -new -x509 -newkey rsa:2048 -nodes \
    -keyout "$TMPDIR/dev.key" -out "$TMPDIR/dev.crt" \
    -days "$DAYS" \
    -subj "/CN=$CERT_NAME" \
    -addext "extendedKeyUsage=codeSigning" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "basicConstraints=critical,CA:false" \
    2>/dev/null

openssl pkcs12 -export \
    -inkey "$TMPDIR/dev.key" -in "$TMPDIR/dev.crt" \
    -out "$TMPDIR/dev.p12" \
    -name "$CERT_NAME" \
    -passout pass:dev \
    -legacy \
    2>/dev/null || \
openssl pkcs12 -export \
    -inkey "$TMPDIR/dev.key" -in "$TMPDIR/dev.crt" \
    -out "$TMPDIR/dev.p12" \
    -name "$CERT_NAME" \
    -passout pass:dev \
    -keypbe PBE-SHA1-3DES \
    -certpbe PBE-SHA1-3DES \
    -macalg sha1 \
    2>/dev/null

echo "🔐 전용 dev keychain에 import 중..."
security import "$TMPDIR/dev.p12" \
    -k "$KEYCHAIN" \
    -P dev

trust_certificate "$TMPDIR/dev.crt"
ensure_keychain_in_search_list

new_hash="$(identity_hash || true)"
if [[ -z "$new_hash" ]]; then
    echo "❌ '$CERT_NAME' identity hash를 전용 keychain에서 찾지 못했습니다." >&2
    echo "진단: security find-identity -p codesigning '$KEYCHAIN'" >&2
    exit 1
fi

if ! sign_smoke_test "$new_hash"; then
    echo "❌ '$CERT_NAME' 생성 후에도 실제 codesign smoke test가 실패했습니다." >&2
    echo "진단:" >&2
    security find-identity -p codesigning "$KEYCHAIN" >&2 || true
    echo "전용 keychain을 삭제 후 재시도하세요:" >&2
    echo "  security delete-keychain '$KEYCHAIN'" >&2
    echo "  WORK_RADAR_DEV_KEYCHAIN_PASSWORD='<user-chosen-password>' pnpm tauri:dev:setup" >&2
    exit 1
fi

finish_success "$new_hash"
