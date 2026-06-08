#!/usr/bin/env bash
# Cargo runner for `tauri dev` that signs the dev binary before it is launched.
#
# Tauri invokes us like:
#   scripts/dev-codesign-runner.sh run --no-default-features --color always -- [app args]
# We turn `cargo run` into `cargo build`, codesign the binary with the repo's
# dedicated dev keychain, then exec it. Signing before launch is required for
# macOS keychain ACL stability.

set -euo pipefail

CERT_NAME="${WORK_RADAR_DEV_CERT:-Work Radar Dev}"
IDENTIFIER="${WORK_RADAR_BUNDLE_IDENTIFIER:-co.kr.mirrorless.workradar}"
BIN_NAME="${WORK_RADAR_BIN_NAME:-work-radar}"
KEYCHAIN="${WORK_RADAR_DEV_KEYCHAIN:-$HOME/Library/Keychains/work-radar-dev.keychain-db}"
KEYCHAIN_PASSWORD="${WORK_RADAR_DEV_KEYCHAIN_PASSWORD:-work-radar-dev}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

resolve_binary_path() {
  local -a args=("$@")
  local profile="debug"
  local target=""
  local bin="$BIN_NAME"
  local target_dir="${CARGO_TARGET_DIR:-target}"

  local i=0
  while (( i < ${#args[@]} )); do
    case "${args[$i]}" in
      --release) profile="release" ;;
      --profile)
        if (( i + 1 < ${#args[@]} )); then profile="${args[$((i + 1))]}"; i=$((i + 1)); fi
        ;;
      --profile=*) profile="${args[$i]#--profile=}" ;;
      --target)
        if (( i + 1 < ${#args[@]} )); then target="${args[$((i + 1))]}"; i=$((i + 1)); fi
        ;;
      --target=*) target="${args[$i]#--target=}" ;;
      --bin)
        if (( i + 1 < ${#args[@]} )); then bin="${args[$((i + 1))]}"; i=$((i + 1)); fi
        ;;
      --bin=*) bin="${args[$i]#--bin=}" ;;
    esac
    i=$((i + 1))
  done

  if [[ "$target_dir" != /* ]]; then
    target_dir="$PWD/$target_dir"
  fi

  if [[ -n "$target" ]]; then
    printf '%s/%s/%s/%s\n' "$target_dir" "$target" "$profile" "$bin"
  else
    printf '%s/%s/%s\n' "$target_dir" "$profile" "$bin"
  fi
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

if (( $# == 0 )); then
  exec cargo
fi

subcommand="$1"
shift

if [[ "$subcommand" != "run" ]]; then
  exec cargo "$subcommand" "$@"
fi

build_args=()
app_args=()
seen_separator=0
for arg in "$@"; do
  if (( seen_separator == 0 )) && [[ "$arg" == "--" ]]; then
    seen_separator=1
    continue
  fi
  if (( seen_separator == 1 )); then
    app_args+=("$arg")
  else
    build_args+=("$arg")
  fi
done

cargo build "${build_args[@]}"

bin_path="$(resolve_binary_path "${build_args[@]}")"
if is_macos; then
  sign_binary "$bin_path"
fi

if (( ${#app_args[@]} > 0 )); then
  exec "$bin_path" "${app_args[@]}"
else
  exec "$bin_path"
fi
