#!/usr/bin/env bash
# Cargo runner for `tauri dev` that signs the dev binary before it is launched.
#
# Tauri invokes us like:
#   scripts/dev-codesign-runner.sh run --no-default-features --color always -- [app args]
# We turn `cargo run` into `cargo build`, codesign the binary with the repo's
# dedicated dev keychain, then exec it. Signing before launch is required for
# macOS keychain ACL stability.

set -euo pipefail

# 키체인/서명 로직 정본은 dev-codesign-lib.sh — exec-signed.sh(cargo 런타임 runner)와 공유한다.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/dev-codesign-lib.sh
source "$LIB_DIR/dev-codesign-lib.sh"

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
