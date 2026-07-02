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

**P4a 완료(2026-07-02)**: enable/disable IPC → 지연 큐 전환. 브리지 헬퍼 master_create_payload
(CreateEventInput → 큐 방언 {title,start,duration_min,all_day,recurrence,time_zone}), 낙관적 미러 +
enqueue. ⚠️P4a가 도입한 **async-enable 윈도우**(google_calendar_id Some, google_event_id NULL)가
`google_event_id.is_some()`로 synced 판단하는 모든 소비자와 TOCTOU를 만듦 → **양측 CAS**로
orphan/re-enable 차단: 워커 create arm은 `WHERE google_calendar_id IS NOT NULL` 조건부 relink(취소면
orphan 삭제), disable/delete_routine은 `WHERE google_event_id IS NULL` 조건부 취소(지면 reload→delete).
codex critic 6라운드 ACCEPT-WITH-NITS. **남은 pending-window NIT(P4b/P4c 큐 전환 시 해소, orphan 아님)**:
move=transient "not_synced", patch/split=stale pre-edit payload, exdate=stale EXDATE.

### P4b — 워커 하드닝 + split/patch/exdate → enqueue (설계 확정 2026-07-02)

**재검토 발견(Fable, P4b 착수 전)**: 커밋된 P3 series_replace arm은 P4a의 async 모델과 미정합 —
latent(아직 아무도 enqueue 안 함), P4b가 도달 가능하게 만들므로 P4b 첫 작업이 하드닝이다.

**A. 워커 하드닝 (sync.rs)**

1. series_replace 가드: `fetch_target_link == None`(미러 NULL = disable/삭제 개입) → **취소**
   (patch/create 모두 skip; w.event_id Some이면 그 orphan best-effort 삭제; Ok). `Some(≠old)` →
   기존대로 no-op. `Some(==old)` → 진행.
2. series_replace relink: 무조건 link_back_impl → **CAS** `WHERE id=? AND google_calendar_id IS NOT
NULL`로 교체(P4a create arm과 동일). 0행 → 새 마스터 best-effort 삭제 + Ok(mark skip).
3. patch arm: target=routine_master + NotFound → **조건부 unlink**(`WHERE id=? AND
google_event_id=?event`) + Terminal("sync expired") — 인라인 clear_google_mirror-on-NotFound
   (ADR-0005 reactive sweep) 패리티. 다른 target은 기존 그대로.
4. unlink_impl routine_master → 조건부 `AND google_event_id = ?evt`(delete arm은 항상 event_id
   Some). 정상 disable은 이미 낙관적으로 clear했으므로 0행이 정상. (P4c move 2-행 설계의 전제.)

**B. enqueue 전환 (google_sync.rs + 호출부 notify 스레딩)** 5. `patch_synced_routine_after_edit`(split): synced(before cal+evt Some) → 기존 순수 빌더로
old*patch=`build_event_payload(capped before-input)`(until_for_previous_day+cap_recurrence_before),
new_create=post-edit row의 큐 방언(`build_master_event_input_with_reference(.., Some(effective*
date))`+ master_create_payload의 Value 버전) → upsert kind=series_replace + notify. 검증 에러
   (empty_window 등)는 enqueue 시점에 동기로 surface(검증=동기, 실행=비동기). **pending-enable**
   (cal Some, evt NULL) → 기존 pending create 행의 payload를 refresh(UPDATE만, INSERT 금지 — P4a
   NIT stale-payload 해소). 미동기화 → no-op.
6.`patch_synced_routine_exdates`: synced → full patch payload {title,start,duration_min,time_zone,
recurrence(EXDATE 포함)} → upsert kind=patch event_id=master + notify. pending-enable → create
payload refresh. 미동기화 → no-op. 토큰/provider fetch 0. 7. 호출부(crud.rs 등)에 notify(State 주입, bindings 무변경) 스레딩.

**문서화된 한계(gold-plate 금지)**: 디바운스 내 연속 편집은 UNIQUE 머지로 원 마스터에서 최종
상태로 1회 split(중간 상태의 미세 이력 편차, 수렴함). terminal 실패 후 재편집 시 w.event_id가
남아 stale-content 마스터 재사용 가능(코너, 문서화만).

### P4c — move(2-행: delete@old_cal + create@new_cal, 각 행이 자기 캘린더 토큰 해석; 조건부

unlink가 전제) + unschedule/restore-today

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
