---
adr-id: ADR-0003
status: accepted
date: 2026-05-28
decision-makers: []
tags: [calendar, sync, retry, queue]
supersedes:
---

# 0003. Pending Calendar Writes Queue with 800ms Debounce

## Context and Problem Statement

**Scope**: `src-tauri/src/calendar/{sync,pending_store}.rs`,
`src-tauri/src/commands/calendar_sync.rs`, migration `0032_pending_calendar_writes.sql`.

드래그 인터랙션은 짧은 시간에 다수의 시간 변경을 발생시킨다. 매번 Google PATCH를
보내면 (a) 네트워크 낭비 (b) Google rate limit 위험 (c) 사용자가 ctrl+z 같은 빠른
되돌리기를 할 때 어색하고 비용 손실. 또한 cross-calendar 이동은 INVARIANT #7에 따라
사용자의 명시적 Acceptance가 필요한 "결정"이다.

## Decision Drivers

- INVARIANT: bounded retry only (`AGENTS.md` Implementation Rules) — backoff +
  jitter + terminal failure 노출.
- INVARIANT #7: 외부 mutation은 사람 손이 게이트(`docs/areas/decision-rails.md`).
- 앱 종료/오프라인 시 사용자 의도가 유실되면 안 됨.
- 워커 한 곳에서 외부 호출 — `commands.*Calendar*`가 직접 Google API를 두드리지
  않도록 차단.

## Considered Options

- Option A: SQLite `pending_calendar_writes` 큐 + 800ms 디바운스 + UNIQUE 머지 +
  staged 플래그(cross-cal Acceptance).
- Option B: in-memory debouncer + 직접 Google 호출.
- Option C: 매 사용자 액션마다 즉시 PATCH (디바운스 없음).

## Decision Outcome

**Rule**: Today×Timeline의 모든 외부 mutation은
`pending_calendar_writes` 큐를 거친다. 프런트 IPC `stage_calendar_write`가
큐에 UPSERT만 하고, sync 워커가 디바운스/재시도/Google 호출을 수행한다.

- `UNIQUE(target_kind, target_id, kind)`로 같은 카드의 후속 변경은 머지.
- `next_attempt_at = now + 800ms`. 같은 row가 800ms 안에 다시 update되면 timer
  리셋 → 마지막 1회만 전송.
- 실패는 backoff `[1s, 3s, 9s]` 3회. terminal failure는 `last_error` 보존 +
  `CalendarSyncFailed` emit.
- Cross-cal 변경은 `payload_json.staged=true`로 큐 행에 보관, 워커가 skip. UI
  "적용" 버튼으로 staged 플래그 제거(`commit_staged_writes`).

Chosen option: "Option A", because INVARIANT(bounded retry) + INVARIANT #7
(Acceptance 게이트) + 종료/오프라인 생존을 동시에 만족하는 유일한 옵션.

### Consequences

- Good: INVARIANT bounded retry 보존(자동화 검사로 점검 가능).
- Good: 앱 종료/오프라인 시 큐 행 보존 → 재부팅 후 자동 재시도.
- Good: optimistic UI와 자연스럽게 결합(캐시 패치 → 큐 → flush).
- Good: cross-cal `MoveCalendar`는 staged=true로 자연스럽게 사용자 Acceptance
  게이트와 결합 — 워커가 staged 행을 skip.
- Bad: 동기화 지연이 항상 800ms+ — UX 차원에서 "곧 동기화됨" 표시가 필요.
- Bad: 같은 카드에 서로 다른 `kind`가 동시에 쌓이면(예: reschedule + resize)
  순서 보장이 필요 — 현재는 워커가 단일 스레드라 OK.

### Confirmation

- `src-tauri/src/calendar/sync.rs` 단위 테스트: UNIQUE 머지, backoff schedule,
  staged=skip, retry 3회 후 `last_error` + 이벤트 emit.
- 프런트에서 `commands.createCalendarEvent` 직접 호출 0건 — grep으로 점검.
- `docs/areas/today-timeline.md` "Sync 워커 호출 패턴" 섹션이 정본.

### Anti-Patterns

- 프런트가 `commands.stageCalendarWrite`를 우회해 외부 캘린더 IPC를 직접 호출.
- 워커 안에서 staged 행을 무시하지 않고 그대로 flush(사용자 Acceptance 우회 = INVARIANT #7 위반).
- 무한 retry(`tokio::time::sleep` 루프 등). 재시도 횟수와 backoff schedule은 코드에 박혀 있어야 한다.
- 큐 행을 프런트에서 직접 mutate(IPC를 통해서만).

## Pros and Cons of the Options

### Option A

- Good, because INVARIANT + 종료/오프라인 생존 + Acceptance 게이트를 한 곳에서 해결.
- Bad, because 800ms 지연으로 즉각 sync를 기대한 사용자에게 어색할 수 있음(UI 표시로 완화).

### Option B

- Good, because 단순.
- Bad, because 앱 종료 시 사용자 의도 손실.
- Bad, because Acceptance 게이트(cross-cal staged)를 자연스럽게 모델링 못 함.

### Option C

- Good, because UX는 즉각.
- Bad, because Google rate limit / 네트워크 낭비 / undo 비용.
- Bad, because 모든 micro-edit가 외부 호출이라 INVARIANT bounded retry 의미 약해짐.

## More Information

- Related: ADR-0002 (카드 정본), ADR-0004 (@dnd-kit 도입).
- Related: spec §6 (Sync Engine), §7 (드래그 인터랙션 행렬).
- Implemented in: PR 2 (워커/IPC) + PR 5 (드래그 wiring) + PR 7 (정리).
- Key files: `src-tauri/migrations/0032_pending_calendar_writes.sql`,
  `src-tauri/src/calendar/sync.rs`, `src-tauri/src/calendar/pending_store.rs`,
  `src-tauri/src/commands/calendar_sync.rs`, `src/lib/calendarSync.ts`.
