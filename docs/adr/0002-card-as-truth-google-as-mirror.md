---
adr-id: ADR-0002
status: accepted
date: 2026-05-28
decision-makers: []
tags: [today, calendar, sync, ssot]
supersedes:
---

# 0002. Card-as-Truth, Google Calendar as Mirror

## Context and Problem Statement

**Scope**: Today × Timeline 표면 (`src/components/today/**`),
`src-tauri/src/calendar/sync.rs`, `src-tauri/src/commands/calendar_sync.rs`.

Today×Timeline 머지(spec 2026-05-28)에서 카드(work-radar signal)를 시간축에
배치하는 행위가 Google Calendar에 실제 이벤트로 저장된다. 카드와 Google 이벤트
둘 다 변경 가능 — 누가 정본인가?

## Decision Drivers

- 카드에는 work-radar 고유 정보(quadrant, area, today_for_date,
  scheduled_at, linked_event_id)가 있다. Google 이벤트엔 없다.
- 외부 호출은 Rust 워커 한 곳으로 모은다 (INVARIANT: 토큰/네트워크는 렌더러 밖).
- 사용자 의도(드래그)는 카드 측에서 발생 → 큐 경유 외부 반영이 자연스럽다.
- 동시 편집(Google 쪽에서 동시에 시간을 옮김) 빈도는 현재 사용자 패턴상 낮다.

## Considered Options

- Option A: 카드 정본 + Google mirror (last-write-wins).
- Option B: Google 정본 + 카드는 캐시.
- Option C: 느슨한 link + 충돌 시 명시적 토스트로 사용자에게 선택 요청.

## Decision Outcome

**Rule**: Today×Timeline에서 시간 정보(`scheduled_at`, `scheduled_duration`)의
정본은 **카드(signal)**이며 Google Calendar는 mirror다. UI는 카드 값을 신뢰하고,
변경은 `pending_calendar_writes` 큐를 거쳐 Google로 전파된다.
Google → 카드 역방향 sync는 last-write-wins(큐에 우리 pending이 있으면 우리 값이 이김).

Chosen option: "Option A", because work-radar 고유 정보와의 정합을 보장하면서
모든 외부 mutation을 Rust 워커 한 곳으로 모을 수 있다.

### Consequences

- Good: work-radar 고유 정보(quadrant/area/today_for_date)가 항상 정합 — 카드를
  지우면 외부 이벤트도 정리된다.
- Good: sync 워커가 단일 외부-호출 진입점이라 INVARIANT(외부 호출 = Rust) 보존.
- Good: 큐 행이 OS 종료/오프라인을 건너 살아남는다 → 재부팅 후 자동 재시도.
- Bad: Google 쪽 동시 편집이 잦은 사용자에겐 변경 손실 가능(현재 사용자 패턴상
  수용). 명시 충돌 토스트는 의도적 deferred — 실제 사용 신호 보고 결정.
- Bad: 카드와 Google이 같은 이벤트를 가리키는 동안 link drift(삭제 또는 ID 변경)
  처리가 필요 — `linked_event_id`가 끊기면 NULL로 폴백.

### Confirmation

- 신규 모든 외부 mutation은 `commands::calendar_sync::stage_calendar_write`를
  거친다 — 프런트가 `commands.createCalendarEvent` 등을 직접 호출하면 리뷰 차단.
- `src-tauri/src/calendar/sync.rs`의 워커 테스트가 last-write-wins 규칙을 검증.
- `docs/areas/today-timeline.md` "Invariants" 섹션에 라우팅.

### Anti-Patterns

- 프런트에서 `commands.updateCalendarEvent`를 직접 호출(큐/디바운스 우회).
- Google 응답을 카드 정본인 양 무조건 덮어쓰기(우리 큐 pending 무시).
- 카드와 Google 양쪽에 같은 정보를 별도 저장(예: title을 두 곳에 동기화).

## Pros and Cons of the Options

### Option A

- Good, because work-radar 고유 정보 정합 + 단일 외부 호출 진입점.
- Bad, because Google 쪽 동시 편집 손실 가능성.

### Option B

- Good, because Google이 권위 있는 캘린더 권위라는 직관에 가깝다.
- Bad, because work-radar 고유 컬럼(quadrant/area)을 Google로 옮길 수 없다.
- Bad, because 매 polling마다 카드 측 상태를 강제로 덮어써 사용자 의도 손실.

### Option C

- Good, because 충돌이 사용자에게 명시 노출.
- Bad, because v1 사용자 패턴에 비해 마찰 과다.

## More Information

- Related: ADR-0003 (pending writes 큐), ADR-0004 (@dnd-kit 도입).
- Related: spec `docs/superpowers/specs/2026-05-28-today-timeline-merge-design.md` §D8.
- Implemented in: PR 1~7 (Today×Timeline merge, 2026-05-28).
- Key files: `src/components/today/**`, `src/lib/todayBlocks.ts`,
  `src-tauri/src/calendar/sync.rs`, `src-tauri/src/commands/calendar_sync.rs`.
