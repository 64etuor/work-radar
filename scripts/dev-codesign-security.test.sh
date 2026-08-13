#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if grep -F -- "set-key-partition-list" "$ROOT_DIR/scripts/dev-codesign-lib.sh" "$ROOT_DIR/scripts/dev-codesign-setup.sh" >/dev/null; then
  echo "FAIL: codesign private-key ACL must remain user-approved" >&2
  exit 1
fi
if grep -E -- 'security import .*|[[:space:]]-A([[:space:]]|$)' "$ROOT_DIR/scripts/dev-codesign-setup.sh" | grep -F -- "-A" >/dev/null; then
  echo "FAIL: security import must not grant every application private-key access" >&2
  exit 1
fi

echo "dev-codesign security tests passed"
