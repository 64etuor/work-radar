#!/usr/bin/env bash
#
# 문서 라인 버짓 — thin-entry 진입 문서가 비대해지는 것을 자동으로 막는다.
# CLAUDE.md/AGENTS.md 는 규칙의 '얇은' 진입점이어야 한다(상세는 PLAN/DESIGN/docs).
# 버짓 초과 = 규칙이 진입 문서로 새고 있다는 신호. 줄이거나 docs/로 옮긴다.
#
# 의도적으로 늘려야 하면 이 표의 숫자를 PR에서 함께 올린다(리뷰 가시화).
#
# 로컬 실행: bash scripts/check-doc-budgets.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# file:max_lines  — 진입(thin) 문서만. PLAN.md/DESIGN.md 는 정본이라 버짓 없음.
budgets=(
  "CLAUDE.md:60"
  "AGENTS.md:90"
)

fail=0
for entry in "${budgets[@]}"; do
  file="${entry%%:*}"
  max="${entry##*:}"
  if [ ! -f "$file" ]; then
    printf '  ? %s 없음 (건너뜀)\n' "$file"
    continue
  fi
  lines=$(wc -l < "$file" | tr -d ' ')
  if [ "$lines" -gt "$max" ]; then
    printf '  ✗ %-12s %s줄 > 버짓 %s줄\n' "$file" "$lines" "$max"
    fail=1
  else
    printf '  ✓ %-12s %s/%s줄\n' "$file" "$lines" "$max"
  fi
done

echo
if [ "$fail" -ne 0 ]; then
  echo "✋ 문서 버짓 초과 — 진입 문서를 줄이거나 상세를 docs/로 옮기세요."
  echo "   (정말 늘려야 하면 scripts/check-doc-budgets.sh 의 버짓을 PR에서 함께 조정.)"
  exit 1
fi
echo "✅ 문서 버짓 통과"
