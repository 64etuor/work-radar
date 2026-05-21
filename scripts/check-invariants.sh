#!/usr/bin/env bash
#
# INVARIANT 구조 게이트 (structural enforcement over prose)
#
# PLAN.md §1 / AGENTS.md 의 7개 INVARIANT 중 "기계로 검증 가능한" 항목만
# 정적으로 강제한다. PR 체크박스(prose)가 아니라 CI에서 막는다.
# 사람 판단이 필요한 항목(아래 'NOT checked' 참조)은 reviewer 패스로 남긴다.
#
# 빠른 정적 검사만 한다(빌드/실행 없음). bindings.ts drift 는
# cargo test 가 필요해 CI rust 잡에서 별도 스텝으로 검증한다.
#
# 로컬 실행: bash scripts/check-invariants.sh
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0
violation() { printf '  ✗ %s\n' "$1"; fail=1; }
group() { printf '\n▶ %s\n' "$1"; }

# ---------------------------------------------------------------------------
# INVARIANT 2 & 7 — 토큰은 OS keychain. 렌더러(프런트)에 노출 금지.
# ---------------------------------------------------------------------------
group "INVARIANT 2/7 — 토큰을 렌더러에 노출 금지"
# 프런트(src/)에서 OS keychain 라이브러리 직접 접근 또는 TOKEN 환경변수 사용 금지.
# 토큰 취급은 전부 Rust(IPC 경계 뒤)에서.
if hits=$(grep -RInE '\b(keytar|keyring)\b|(process\.env|import\.meta\.env)\.[A-Za-z_]*TOKEN' \
            src --include='*.ts' --include='*.tsx' 2>/dev/null); then
  violation "프런트에서 토큰/keychain 직접 접근 흔적:"
  printf '%s\n' "$hits" | sed 's/^/      /'
else
  printf '  ✓ 프런트에 keychain/TOKEN 직접 접근 없음\n'
fi

# ---------------------------------------------------------------------------
# INVARIANT 7 — SSOT 분리. SQLite에 토큰/시크릿 평문 컬럼 금지.
#   (cost_tokens 같은 "토큰 수" 카운터는 시크릿이 아니므로 제외 — 명시적 이름만 검사.)
# ---------------------------------------------------------------------------
group "INVARIANT 7 — SQLite에 시크릿 평문 저장 금지"
if [ -d src-tauri/migrations ]; then
  if hits=$(grep -RInE '\b(secret|password|api_key|access_token|refresh_token)\b' \
              src-tauri/migrations 2>/dev/null); then
    violation "마이그레이션에 시크릿 컬럼 의심 (토큰은 keychain에만):"
    printf '%s\n' "$hits" | sed 's/^/      /'
  else
    printf '  ✓ 마이그레이션에 시크릿 컬럼 없음\n'
  fi
fi

# ---------------------------------------------------------------------------
# INVARIANT 6 — Codex 샌드박스. danger-full-access 활성화 금지.
#   (config.toml 의 주석은 금지를 '명시'하므로, 주석이 아닌 활성 설정만 검사.)
# ---------------------------------------------------------------------------
group "INVARIANT 6 — Codex danger-full-access 금지"
if [ -f .codex/config.toml ]; then
  if hits=$(grep -nE '^[[:space:]]*[^#[:space:]].*danger' .codex/config.toml 2>/dev/null); then
    violation "Codex 설정에 활성 danger 모드:"
    printf '%s\n' "$hits" | sed 's/^/      /'
  else
    printf '  ✓ Codex danger-full-access 비활성\n'
  fi
fi

# ---------------------------------------------------------------------------
# NOT checked here (사람 reviewer 패스 유지 — 정적 검증 불가):
#   INVARIANT 1  결정 레일은 사람만 (자동 분류/승격 금지)
#   INVARIANT 2  모든 외부 변경은 Acceptance 게이트
#   INVARIANT 3  신호 dedup upsert + auto-resolve
#   INVARIANT 4  매트릭스는 결정 큐 / ambient escalate
#   INVARIANT 5  에이전트 잡 bound (timeout/turns/cost/kill) + 무한 retry 금지
# ---------------------------------------------------------------------------

echo
if [ "$fail" -ne 0 ]; then
  echo "✋ INVARIANT 구조 게이트 위반 — 위 항목을 수정하세요."
  exit 1
fi
echo "✅ INVARIANT 구조 게이트 통과"
