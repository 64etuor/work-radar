#!/usr/bin/env bash
# exec-signed.sh 계약 테스트 (mock security/codesign — dev-codesign-runner.test.sh와 동일 하네스).
#
# exec-signed.sh = cargo 런타임 runner(`runner <binary> [args...]`) 겸 범용 exec wrapper.
# 계약:
#   1. 앱 바이너리(basename == work-radar)는 실행 "직전" 고정 identity로 서명 후 exec.
#   2. 비-앱 바이너리(cargo test 바이너리 등)는 서명 없이 그대로 exec (pass-through).
#   3. 전용 dev keychain이 없으면 앱 실행을 막고 setup 힌트를 낸다(무서명 실행 방지).
#   4. WORK_RADAR_UNSIGNED_DEV=1 escape hatch — 서명 없이 exec.
#   5. 비-macOS는 무조건 pass-through.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/exec-signed.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local needle="$1"
  local file="$2"
  grep -F -- "$needle" "$file" >/dev/null || fail "expected '$needle' in $file; got: $(cat "$file")"
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  if grep -F -- "$needle" "$file" >/dev/null; then
    fail "did not expect '$needle' in $file; got: $(cat "$file")"
  fi
}

# needle1이 needle2보다 먼저 나와야 한다(서명이 exec보다 먼저).
assert_order() {
  local first="$1"
  local second="$2"
  local file="$3"
  local l1 l2
  l1="$(grep -Fn -- "$first" "$file" | head -1 | cut -d: -f1)"
  l2="$(grep -Fn -- "$second" "$file" | head -1 | cut -d: -f1)"
  [[ -n "$l1" && -n "$l2" ]] || fail "order: missing lines in $file; got: $(cat "$file")"
  (( l1 < l2 )) || fail "expected '$first' before '$second' in $file; got: $(cat "$file")"
}

[[ -x "$SCRIPT" ]] || fail "scripts/exec-signed.sh가 없거나 실행 불가"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
FAKE_BIN="$TEST_DIR/bin"
mkdir -p "$FAKE_BIN"
LOG="$TEST_DIR/log"
export LOG
export PATH="$FAKE_BIN:$PATH"
export WORK_RADAR_FORCE_CODESIGN=1
export WORK_RADAR_DEV_KEYCHAIN="$TEST_DIR/work-radar-dev.keychain-db"
export WORK_RADAR_DEV_KEYCHAIN_PASSWORD="test-only-password"
touch "$WORK_RADAR_DEV_KEYCHAIN"

cat > "$FAKE_BIN/security" <<'FAKE_SECURITY'
#!/usr/bin/env bash
echo "security:$*" >> "$LOG"
case "$1" in
  unlock-keychain) exit 0 ;;
  list-keychains)
    if [[ "$2" == "-s" ]]; then exit 0; fi
    echo '    "/Users/test/Library/Keychains/login.keychain-db"'
    exit 0
    ;;
  find-identity)
    echo '  1) ABCDEF1234567890 "Work Radar Dev"'
    exit 0
    ;;
esac
FAKE_SECURITY
chmod +x "$FAKE_BIN/security"

cat > "$FAKE_BIN/codesign" <<'FAKE_CODESIGN'
#!/usr/bin/env bash
echo "codesign:$*" >> "$LOG"
FAKE_CODESIGN
chmod +x "$FAKE_BIN/codesign"

# 가짜 앱/테스트 바이너리.
APP_DIR="$TEST_DIR/target/debug"
mkdir -p "$APP_DIR"
cat > "$APP_DIR/work-radar" <<'APP'
#!/usr/bin/env bash
echo "app:$*" >> "$LOG"
APP
chmod +x "$APP_DIR/work-radar"
cp "$APP_DIR/work-radar" "$APP_DIR/work_radar-abc123"
sed -i '' 's/app:/testbin:/' "$APP_DIR/work_radar-abc123" 2>/dev/null || sed -i 's/app:/testbin:/' "$APP_DIR/work_radar-abc123"

# ── 1. 앱 바이너리: 서명 → exec 순서 + 인자 보존 ─────────────────────────────
: > "$LOG"
"$SCRIPT" "$APP_DIR/work-radar" --mcp-stdio
assert_contains "codesign:--force --sign ABCDEF1234567890 --identifier co.kr.mirrorless.workradar $APP_DIR/work-radar" "$LOG"
assert_not_contains "set-key-partition-list" "$LOG"
assert_contains "app:--mcp-stdio" "$LOG"
assert_order "codesign:" "app:" "$LOG"

# ── 2. 비-앱 바이너리(cargo test 바이너리): 서명 없이 pass-through ───────────
: > "$LOG"
"$SCRIPT" "$APP_DIR/work_radar-abc123" --test-threads 1
assert_contains "testbin:--test-threads 1" "$LOG"
assert_not_contains "codesign:" "$LOG"
assert_not_contains "security:" "$LOG"

# ── 3. dev keychain 없음: 앱 실행 차단 + setup 힌트 ─────────────────────────
: > "$LOG"
rc=0
WORK_RADAR_DEV_KEYCHAIN="$TEST_DIR/missing.keychain-db" \
  "$SCRIPT" "$APP_DIR/work-radar" --mcp-stdio 2> "$TEST_DIR/stderr" || rc=$?
(( rc != 0 )) || fail "keychain 없음이면 non-zero exit이어야 한다"
assert_not_contains "app:" "$LOG"
assert_contains "tauri:dev:setup" "$TEST_DIR/stderr"

# ── 4. WORK_RADAR_UNSIGNED_DEV=1: escape hatch — 서명 없이 exec ─────────────
: > "$LOG"
WORK_RADAR_UNSIGNED_DEV=1 "$SCRIPT" "$APP_DIR/work-radar" --mcp-stdio
assert_contains "app:--mcp-stdio" "$LOG"
assert_not_contains "codesign:" "$LOG"

# ── 5. 비-macOS: 무조건 pass-through ────────────────────────────────────────
cat > "$FAKE_BIN/uname" <<'FAKE_UNAME'
#!/usr/bin/env bash
echo "Linux"
FAKE_UNAME
chmod +x "$FAKE_BIN/uname"
: > "$LOG"
WORK_RADAR_FORCE_CODESIGN=0 "$SCRIPT" "$APP_DIR/work-radar" --mcp-stdio
assert_contains "app:--mcp-stdio" "$LOG"
assert_not_contains "codesign:" "$LOG"
rm -f "$FAKE_BIN/uname"

echo "exec-signed tests passed"
