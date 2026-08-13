#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

cat > "$FAKE_BIN/cargo" <<'FAKE_CARGO'
#!/usr/bin/env bash
echo "cargo:$*" >> "$LOG"
if [[ "$1" == "build" ]]; then
  mkdir -p target/debug
  cat > target/debug/work-radar <<'APP'
#!/usr/bin/env bash
echo "app:$*" >> "$LOG"
APP
  chmod +x target/debug/work-radar
fi
FAKE_CARGO
chmod +x "$FAKE_BIN/cargo"

cat > "$FAKE_BIN/tauri" <<'FAKE_TAURI'
#!/usr/bin/env bash
echo "tauri:$*" >> "$LOG"
FAKE_TAURI
chmod +x "$FAKE_BIN/tauri"

(
  cd "$TEST_DIR"
  "$ROOT_DIR/scripts/dev-codesign-runner.sh" run --no-default-features --color always -- --smoke value
)
assert_contains "cargo:build --no-default-features --color always" "$LOG"
assert_contains "security:find-identity -p codesigning $WORK_RADAR_DEV_KEYCHAIN" "$LOG"
assert_contains "codesign:--force --sign ABCDEF1234567890 --identifier co.kr.mirrorless.workradar $TEST_DIR/target/debug/work-radar" "$LOG"
assert_not_contains "set-key-partition-list" "$LOG"
assert_contains "app:--smoke value" "$LOG"

: > "$LOG"
"$ROOT_DIR/scripts/tauri-wrapper.sh" dev --no-watch
assert_contains "tauri:dev --runner $ROOT_DIR/scripts/dev-codesign-runner.sh --no-watch" "$LOG"

: > "$LOG"
"$ROOT_DIR/scripts/tauri-wrapper.sh" dev --runner custom-runner --no-watch
assert_contains "tauri:dev --runner custom-runner --no-watch" "$LOG"
assert_not_contains "$ROOT_DIR/scripts/dev-codesign-runner.sh" "$LOG"

: > "$LOG"
WORK_RADAR_UNSIGNED_DEV=1 "$ROOT_DIR/scripts/tauri-wrapper.sh" dev --no-watch
assert_contains "tauri:dev --no-watch" "$LOG"
assert_not_contains "--runner" "$LOG"

echo "dev-codesign runner tests passed"
