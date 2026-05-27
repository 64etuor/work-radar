---
adr-id: ADR-0004
status: accepted
date: 2026-05-28
decision-makers: []
tags: [frontend, dnd, dependencies]
supersedes:
---

# 0004. Adopt @dnd-kit/core for Today × Timeline (Coexists with useListReorder)

## Context and Problem Statement

**Scope**: `src/components/today/**`, `src/lib/useListReorder.ts` (보드).

보드는 자작 훅 `useListReorder`로 리스트 정렬 드래그를 처리해왔다. 새 Today
시간축은 (a) 픽셀 좌표 기반 드롭(분 단위 스냅), (b) 블록 리사이즈, (c) 여러
드롭존(트레이/캔버스/cross-cal), (d) 키보드 sensor가 필요해 자작으로 확장하는
비용이 크다.

## Decision Drivers

- 픽셀 + 그리드 스냅을 표준 API로 처리해야 한다.
- 키보드 sensor + a11y(`aria-grabbed`, screen reader announce)가 즉시 필요하다.
- Esc로 드래그 취소가 표준 동작이어야 한다.
- 보드의 `useListReorder`는 안정적이고 도메인 특화 — 무리하게 통합하면 회귀 위험.

## Considered Options

- Option A: `@dnd-kit/core` + `@dnd-kit/utilities` 도입, Today에만 사용.
  보드는 `useListReorder` 유지.
- Option B: `useListReorder`를 확장해 픽셀/리사이즈/멀티 드롭존 지원.
- Option C: react-dnd 등 다른 라이브러리.

## Decision Outcome

**Rule**: Today × Timeline의 드래그는 `@dnd-kit/core`를 사용한다.
사용 범위는 `src/components/today/**`로 한정한다. 보드(`useListReorder`)는
변경 없이 유지한다 — YAGNI.

Chosen option: "Option A", because 가장 좁은 변경으로 a11y/픽셀/멀티 드롭존을
얻고, 검증된 보드 코드를 건드리지 않는다.

### Consequences

- Good: 키보드 sensor + a11y 기본 제공. Esc 드래그 취소도 dnd-kit이 처리.
- Good: 픽셀 + 그리드 스냅을 표준 API로 처리.
- Good: 보드 회귀 0 — 기존 `useListReorder` 사용자 무영향.
- Bad: 두 가지 드래그 패턴이 코드베이스에 공존 — 미래에 보드도 마이그할지
  별도 결정 필요(현재는 No).
- Bad: 번들 사이즈 증가(`@dnd-kit/core` + `utilities` ~40KB gzip).

### Confirmation

- `package.json`에 `@dnd-kit/core`/`@dnd-kit/utilities` 추가.
- `import.*@dnd-kit` grep 결과는 `src/components/today/**`에만 등장해야 한다.
- 키보드 only로 드래그 가능 (Tab → 블록 → Space → 화살표 → Space, Esc로 취소).

### Anti-Patterns

- 보드 컴포넌트에 `@dnd-kit` import — 결정 범위 위반.
- `@dnd-kit` 외에 다른 드래그 라이브러리 동시 도입.
- `useListReorder`를 `@dnd-kit`으로 재작성하면서 회귀 테스트 없음.

## Pros and Cons of the Options

### Option A

- Good, because 가장 좁은 변경으로 a11y/픽셀/멀티 드롭존 확보.
- Bad, because 두 가지 드래그 패턴 공존(문서로 경계 명시 필요).

### Option B

- Good, because 한 가지 패턴 유지.
- Bad, because 자작 코드에 a11y 기본을 다시 구현해야 함.
- Bad, because 검증된 보드 코드를 건드려 회귀 위험.

### Option C

- Good, because 다른 옵션 비교 풀.
- Bad, because react-dnd는 HTML5 백엔드 의존 + a11y/키보드가 약함.

## More Information

- Related: ADR-0002 (카드 정본), ADR-0003 (pending writes 큐).
- Related: spec §8.4 (의존성), §D14.
- Implemented in: PR 5 (드래그 wiring) + PR 7 (a11y 정리).
- Key files: `src/components/today/useTimelineDnd.ts`,
  `src/components/today/TimelineBlock.tsx`,
  `src/components/today/UnscheduledTray.tsx`,
  `src/components/today/TimelineCanvas.tsx`.
