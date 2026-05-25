#!/usr/bin/env bash
# 1회 실행: self-signed code signing cert를 login keychain에 자동 등록.
#
# WHY: GUI(Keychain Access → Certificate Assistant)는 macOS 버전마다 단계가
# 달라 사용자가 헷갈리기 쉬움. 이 스크립트는 openssl로 cert + private key를
# 생성하고 `security import`로 login keychain에 넣은 뒤 codesign이 private
# key에 접근할 수 있도록 partition list까지 설정한다.
#
# USAGE: `pnpm tauri:dev:setup` (또는 `bash scripts/dev-codesign-setup.sh`)
#
# IDEMPOTENT: cert가 이미 있으면 skip.

set -e

CERT_NAME="${WORK_RADAR_DEV_CERT:-Work Radar Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
DAYS=3650

# 이미 있으면 skip — 멱등.
if security find-certificate -c "$CERT_NAME" >/dev/null 2>&1; then
    echo "✓ '$CERT_NAME' 인증서가 이미 키체인에 있습니다 — skip."
    echo "  다시 만들려면 먼저 삭제: security delete-certificate -c '$CERT_NAME'"
    exit 0
fi

# macOS only.
if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "❌ macOS 전용 스크립트입니다." >&2
    exit 1
fi

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "🔧 self-signed code signing cert 생성 중 ('$CERT_NAME')..."

# 1. 자체 서명 cert + private key 생성.
#    extendedKeyUsage=codeSigning + basicConstraints=CA:false 가 핵심
#    (이게 없으면 codesign이 cert를 인식 못함).
openssl req -new -x509 -newkey rsa:2048 -nodes \
    -keyout "$TMPDIR/dev.key" -out "$TMPDIR/dev.crt" \
    -days "$DAYS" \
    -subj "/CN=$CERT_NAME" \
    -addext "extendedKeyUsage=codeSigning" \
    -addext "basicConstraints=CA:false" \
    2>/dev/null

# 2. PKCS12로 묶기 (security import가 받는 포맷).
#    -legacy: openssl 3.x는 기본으로 AES-256/SHA-256 PBE를 쓰는데 macOS Security
#    framework는 옛 SHA-1 기반(PBE-SHA1-3DES)만 지원해 "MAC verification failed"
#    에러로 import가 실패. -legacy는 OpenSSL 3.0+에서 옛 PKCS12 알고리즘으로 폴백.
#    LibreSSL이나 openssl 1.x에서는 옵션 무시되므로 둘 다 호환.
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

# 3. login keychain에 import.
#    -T /usr/bin/codesign: codesign이 이 cert의 private key를 사용할 수 있음.
echo "🔐 login keychain에 import 중 (비밀번호 prompt 가능)..."
security import "$TMPDIR/dev.p12" \
    -k "$KEYCHAIN" \
    -P dev \
    -T /usr/bin/codesign \
    -T /usr/bin/security

# 4. Sierra+ partition list 갱신 — private key 접근 권한 부여.
#    이게 없으면 codesign 실행 때마다 "Allow / Always Allow" prompt가 뜸.
echo "🔓 codesign 접근 권한 부여 중 (비밀번호 prompt 가능)..."
security set-key-partition-list \
    -S "apple-tool:,apple:,codesign:" \
    -s -k "" "$KEYCHAIN" \
    >/dev/null 2>&1 || {
        echo "⚠️  partition list 설정 실패 — codesign 실행 시 권한 prompt가 뜰 수 있음." >&2
        echo "   수동으로: security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <login-password> \"$KEYCHAIN\"" >&2
    }

echo ""
echo "✅ 완료 — '$CERT_NAME' 인증서 등록됨"
echo ""
echo "확인:"
echo "  security find-certificate -c '$CERT_NAME' >/dev/null && echo OK"
echo ""
echo "이제 dev 부팅:"
echo "  pnpm tauri:dev:signed"
