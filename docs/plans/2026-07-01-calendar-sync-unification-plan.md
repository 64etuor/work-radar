# 캘린더 동기화 단일 큐 통합 플랜 (2026-07-01)

## 문제 (진단 확정)

캘린더 동기화에 **두 개의 평행 시스템**이 있고 루틴이 양다리를 걸친다:

- **경로 A — 지연 큐** (`src-tauri/src/calendar/sync.rs`, `pending_store.rs`, `commands/calendar_sync.rs`):
  `pending_calendar_writes` 큐 + 디바운스 + 백그라운드 flush + 백오프 재시도. 대상 = 시그널,
  루틴 **개별 날짜** 인스턴스(`routine_check`).
- **경로 B — 인라인 직접** (`commands/routines/google_sync.rs`, 98KB, provider 직접호출 **205회**):
  루틴 **반복 마스터 시리즈**(RRULE) enable/disable/move/patch/split/delete/exdate를 IPC 핸들러
  안에서 즉시 실행. 재시도/일관성 모델이 경로 A와 다름.

증상: 편집/이동/삭제/tz·활성기간이 "제대로 다 적용" 안 되는 체감 + 유지보수 불가능한 god 파일.

## 핵심 통찰

Google에서 **반복 마스터 = `recurrence: ["RRULE:...","EXDATE;TZID=...:..."]` 필드를 단 이벤트**다.
`CreateEventInput`은 **이미** `recurrence: Vec<String>` + `time_zone: Option<String>`을 갖고
`build_event_payload`(write.rs)가 반복 이벤트로 직렬화한다. 그런데 큐의 `parse_create_input`
(sync.rs)은 `..Default::default()`로 **그 두 필드를 버린다**. → 큐는 이미 events.insert/patch/delete를
다 하므로, recurrence/time_zone을 payload에 실어 보내면 **반복 시리즈도 그대로 큐로 흐른다.**
경로 B가 존재할 구조적 이유가 없다.

## 목표 아키텍처

모든 캘린더 mutation을 **하나의 지연 큐**로:

- `pending_calendar_writes.target_kind`에 `routine_master`(target_id = routine_id) 추가.
  (⚠️정정: target_kind에 CHECK 제약 `IN ('signal','routine_check','event')`(마이그 0033)이 있어
  스키마 변경 필요 — 마이그 0062가 0033 재구축 패턴으로 CHECK에 `routine_master` 추가. 큐 행 보존.)
- `google_sync.rs`의 순수 빌더(RRULE / UNTIL→UTC / tz SSOT / active-period DTSTART-floor / split /
  exdate)는 **정본이므로 보존**. 단 **실행·재시도·일관성은 큐가 소유** → provider 직접호출 0회로.
- `link_back_impl`/`unlink_impl`/`fetch_target_link`에 `routine_master` arm 추가 →
  `routines.google_event_id`/`google_calendar_id`도 큐가 기록. 세 target 한 메커니즘.

## 불변 (반드시 보존 — 위반 시 차단)

1. **동작 보존**: 관측 동작 동일. "지금 되던 건 그대로, 안 되던 것만 고침." split/exdate/active-period
   현재 정본 계산 로직 보존, **실행 경로만** 큐로 이동.
2. INVARIANT #2: cross-cal 이동은 `staged=true`(Acceptance 게이트). AI-origin write는 게이트 경유.
3. INVARIANT #5: bounded retry(백오프 [1s,3s,9s] 3회 후 terminal surfacing). 무한 retry/poll 금지.
4. 외부 토큰은 keychain, 렌더러 미노출. 로그에 토큰/외부 응답 본문 금지.
5. tauri-specta 바인딩 drift = CI 게이트. 새 IPC 타입은 생성 타입만.
6. SQLite는 마이그레이션으로만. 임의 ALTER 금지.

## 페이즈 (각 페이즈: TDD 필수 · 독립 shippable · 별도 codex critic ACCEPT 전엔 미완)

### P1 — payload에 recurrence/time_zone 통로 개통 (순수 확장, 행동 변화 0)

- `sync.rs::parse_create_input`: payload_json에서 `recurrence: [String]`(있으면)과 `time_zone: String`
  (있으면)을 읽어 `CreateEventInput`에 전달. 없으면 기존과 동일(빈 vec / None).
- `sync.rs::build_patch_body`: patch payload에 `recurrence`가 있으면 Google patch body에
  `recurrence` 배열 동봉(+ recurring이면 start/end에 `timeZone`, dateTime은 wall-clock).
- **TDD**: 실패 테스트 먼저 — recurrence 실은 create payload → provider가 recurrence 배열 받는지;
  recurrence 없는 기존 payload는 바이트 동일(회귀 없음).
- **Done**: `cargo test` green, 기존 create/patch 동작 불변 증거(테스트), clippy/fmt 0.

### P2 — `routine_master` target arm (링크백/언링크/prev-link)

- `link_back_impl`/`unlink_impl`/`fetch_target_link`/`split_routine_key` 계열에 `routine_master` arm.
  링크백 = `UPDATE routines SET google_event_id=?, google_calendar_id=? WHERE id=?`.
  언링크 = 두 컬럼 NULL. target_id = routine_id(파이프 없음).
- **TDD**: 실패 테스트 — routine_master create 큐 행 → worker execute → routines.google_event_id 박힘;
  delete → NULL.
- **Done**: cargo test green, 기존 signal/routine_check arm 불변.

### P3 — `series_replace` worker kind (split 원자화)

- 새 kind `series_replace`: 한 execute 안에서 **옛 마스터 UNTIL cap(patch) + 새 마스터 create**를
  원자 시퀀스로(기존 create의 "옛 오펀 삭제" defense-in-depth 패턴 재사용). payload = {old_event_id,
  old_recurrence_capped, new_create_input}. 순서 경쟁 제거.
- **TDD**: 실패 테스트 — series_replace 행 → 옛 마스터 patch(UNTIL) + 새 마스터 create 둘 다 호출,
  routines 링크 새 id로 이동, 부분 실패 시 재시도 안전.
- **Done**: cargo test green.

### P4 — IPC 인라인 → enqueue 전환 (google_sync.rs 실행부 제거)

- enable/disable/move/patch/split/delete/exdate IPC가 provider 직접호출 대신 **enqueue**.
  순수 빌더(RRULE/UNTIL/tz/active-period/split 계산)는 그대로 호출해 payload 구성 → upsert_write.
  google_sync.rs의 205 provider 직접호출 → 0회. 재시도/일관성은 큐 소유.
- **TDD**: 실패 테스트 먼저 — 각 IPC 호출이 올바른 큐 행(kind/target/ payload)을 만드는지;
  provider를 직접 안 부르는지. 기존 google_sync 순수 빌더 테스트 보존.
- **Done**: cargo test green, google_sync.rs provider 직접호출 grep=0, bindings drift 0.

### P5 (follow-up) — 로컬 미러 원자화(트랜잭션) + overlay가 routine_master pending 반영

### P6 (follow-up) — 큐 행 TTL GC, staged 플래그 스키마화 등 잔여 smell

## 검증 (정본: docs/reference/commands.md)

- Rust: `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`
- 프런트(닿으면): `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` + bindings drift 게이트
- 각 페이즈 종료: 별도 **codex critic** 파견 → ACCEPT 전엔 다음 페이즈 금지(self-approve 금지).

## 참조

- 진단 근거: `calendar/sync.rs`, `calendar/mod.rs`, `commands/routines/google_sync.rs`,
  `commands/calendar_sync.rs`, Explore 매핑(smell 10건 + 식별자 4-tier 모델).
- area 문서: `docs/areas/ipc-conventions.md`, `docs/areas/data-layer-conventions.md`,
  `docs/areas/decision-rails.md`(INVARIANTS).
