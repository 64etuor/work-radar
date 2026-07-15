# Routine Tracking Editorial Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 루틴 트래킹을 기존 데이터 계약을 보존한 편집형 성과표로 재구성한다.

**Architecture:** `RoutineTrackingView`가 기존 query orchestration과 기간 상태를 계속 소유한다.
순수 파생 함수가 전체 요약을 계산하고, 표시 전용 하위 컴포넌트가 요약과 행을 렌더한다.
새 IPC, mutation, 전역 토큰은 추가하지 않는다.

**Tech Stack:** React 19, TypeScript, component CSS, Tailwind v4 tokens, Vitest, Tauri 2

---

### Task 1: Lock the scorecard contract

**Files:**

- Create: `src/components/RoutineTrackingView.dom.test.tsx`

**Step 1:** query hooks와 세션 상태를 mock하고, 빈도와 due 수가 다른 루틴 fixture를 렌더한다.

**Step 2:** 전체 이행률이 `sum(done) / sum(due)`로 계산되고 완료 occurrence·활성 streak·개별
루틴 행의 접근성 이름이 렌더되는지 assertion을 추가한다.

**Step 3:** `pnpm vitest run src/components/RoutineTrackingView.dom.test.tsx`를 실행한다.
Expected: 새 성과표 구조가 없어 FAIL.

### Task 2: Build the editorial hierarchy

**Files:**

- Modify: `src/components/RoutineTrackingView.tsx`

**Step 1:** 순수 `summarizeTracking` 함수로 가중 이행률·완료/due·활성 streak를 계산한다.

**Step 2:** 제목/기간 toolbar, summary scorecard, rule-separated routine row 구조를 추가한다.

**Step 3:** 기존 loading/error/empty 분기를 semantic section으로 정리하고 query·기간 상태·데이터
순서는 그대로 둔다.

**Step 4:** targeted test를 다시 실행한다. Expected: 구조와 지표 PASS.

### Task 3: Apply responsive editorial styling

**Files:**

- Modify: `src/components/RoutineTrackingView.css`

**Step 1:** rounded cards를 제거하고 open canvas, hairline rules, aligned numeric columns로 바꾼다.

**Step 2:** 900px과 640px responsive grid, bounded history overflow, final-geometry skeleton을 추가한다.

**Step 3:** motion을 transform/opacity/width로 제한하고 reduced-motion override를 유지한다.

### Task 4: Verify and publish the work unit

**Files:**

- Test: `src/components/RoutineTrackingView.dom.test.tsx`
- Test: `src/components/viewRootHeight.test.ts`

**Step 1:** 관련 Vitest, typecheck, lint, build, design/class/ownership guards, diff check를 실행한다.

**Step 2:** react-doctor diff scan을 실행하고 변경 범위의 회귀를 수정한다.

**Step 3:** Tauri 앱에서 desktop/narrow 화면과 7/30/90일 기간 전환을 시각 QA한다.

**Step 4:** 문서와 구현을 원자적 Conventional Commit으로 나누고 각각 `origin/dev`에 푸시한다.
