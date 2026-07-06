# 가계부 — 카테고리별 예산 탭 (`예산`) 설계

날짜: 2026-07-05 · 상태: 승인됨 (구현 진행)

## 문제 / 기대 영향

카테고리별 월 예산 백엔드(`bookkeeping_budgets` 테이블, `set/list/delete/status` 커맨드,
롤오버·집행률 계산)는 이미 존재하나, UI는 "정기·예산" 탭 안의 작은 `BudgetCard` 폼으로
묻혀 있다. 카테고리별 예산을 **계획(산정)** 하는 1급 표면이 없고, 지출이 있으나 예산이
없는 카테고리가 눈에 띄지 않는다.

기대: 전용 **`예산` 탭**에서 (1) 카테고리별 한도를 표로 한눈에 편집, (2) 과거 지출 기반
**자동 산정(제안)**, (3) 지출 있는 **미설정 카테고리 자동 노출**.

## 결정 (사용자 승인)

- 전용 `예산` 탭 신설 + 자동 산정 둘 다.
- 산정 근거: **직전 완결 N개월(당월 제외) 평균**, 기본 3개월, 1,000원 단위 반올림.
- 가변 카테고리: **지출 있는 모든 상위 카테고리 자동 나열 + 미설정 강조**. (사용자가 새
  분류를 만드는 기능은 범위 밖 — taxonomy 확장 없음.)
- 입도: **상위 카테고리만** (현행 `BudgetCard`/`spent_for_budget_category`와 동일).
- 스코프: 현행대로 `activeProjectId` + `month`.
- 신규 mutation 없음 — `set_bookkeeping_budget`/`delete_bookkeeping_budget` 재사용.

## 백엔드 (Rust · tauri-specta)

신규 조회 커맨드 하나로 탭 데이터를 서버에서 합쳐 반환 (FE 다중쿼리 stitching 회피):

```
bookkeeping_budget_planner(month, project_id, months_back) -> Vec<BookkeepingBudgetPlanRow>
```

`BookkeepingBudgetPlanRow` (specta, i32/`Option`만):
`{ category_code, label, limit_minor: Option<i32>, budget_id: Option<String>, rollover: bool,
   spent_minor, rollover_in_minor, remaining_minor, pct: f64, suggested_minor, has_budget: bool }`

- **행 집합** = (해당 월 예산 있는 상위 카테고리) ∪ (직전 N개월 또는 당월에 지출 있는 상위
  카테고리). 그룹핑은 예산 매칭과 동일하게 `COALESCE(category_code, category)`.
- **suggested_minor** = 직전 완결 N개월 지출 합 ÷ N, 1,000원 단위 반올림. 당월 제외.
- 지출/롤오버/집행률은 기존 `spent_for_budget_category` · `rollover_in_for_budget`
  · `category_label` 재사용. `pct`/`remaining` 계산식은 `budget_status`와 동일.
- `months_back`는 1..=24로 clamp. `validate_month` 재사용.
- `lib.rs` `collect_commands!`에 등록 → `cargo test`가 `src/bindings.ts` 재생성.

## 프런트

- `bookkeepingTabs.ts`: `budget`("예산") 탭 추가 → `검토·원장·정기·예산·리포트·가져오기`.
  기존 `recurring` 라벨 "정기·예산" → **"정기"**.
- 신규 `cards/BudgetPlannerPanel.tsx`: 자체 쿼리/뮤테이션 소유(BookkeepingView 비대화 방지).
  - shadcn 테이블: 카테고리 | 최근 N개월 평균(제안) | 이번달 지출 | 예산 한도(인라인 Input) |
    잔여·집행률 bar | 이월 toggle | 행 저장/삭제.
  - "제안" 버튼(행별) → 한도에 `suggested_minor` 채움. "미설정 전체 제안 적용" 일괄 버튼.
  - `has_budget=false` → `data-unset` "미설정" 배지 강조.
  - 상단 KPI: 총 예산 / 총 지출 / 총 잔여. `months_back` 셀렉트(3/6/12).
  - 집행률/초과색은 기존 `budgetBarPercent`/`isBudgetOverrun` 재사용.
- `query/bookkeeping.ts`: `useBookkeepingBudgetPlanner(month, projectId, monthsBack)` 추가.
  뮤테이션은 `useSetBookkeepingBudget`/`useDeleteBookkeepingBudget` 재사용
  (`useInvalidateBookkeeping`가 `["bookkeeping"]` 광역 무효화 → planner 자동 refetch).
- `BookkeepingView.tsx`: `recurring` 탭에서 `BudgetCard` 및 budget draft/submit 상태 제거,
  신규 `budget` 탭 패널에 `<BudgetPlannerPanel month project />` 렌더. `BudgetCard.tsx`는
  대체되어 제거.
- 순수 헬퍼 `budgetPlanner.ts` + `budgetPlanner.test.ts`: 제안 반올림, 미설정 판정, KPI 합산.

## 테스트 / 게이트

- Rust: `bookkeeping_budget_planner` 단위테스트 — 당월 제외 평균, 예산 없는 지출 카테고리
  포함, 반올림, project 스코프. (`commands/bookkeeping/mod.rs` 기존 테스트 패턴)
- FE: `budgetPlanner.test.ts` + 패널 DOM 스모크 1개.
- 게이트(실행 증거): `cargo test`, `cargo clippy --all-targets -D warnings`, `cargo fmt --check`,
  `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`, `git diff --exit-code src/bindings.ts`.

## INVARIANT 정합

Rust 계산·`AppError` envelope·specta i64 금지(i32 유지)·수기 TS IPC 금지(bindings 재생성)·
마이그레이션 불요(스키마 재사용)·단일부기 유지·최소 변경.
