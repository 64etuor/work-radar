# Routine → Google Calendar 동기화: RRULE `UNTIL`을 UTC로 (설계)

- 날짜: 2026-06-26
- 영역: row 14 Today×Timeline / row 2 Rust domain (`routines/**`, `commands/routines/**`)
- 정본 결정: ADR-0005(Option A, PATCH-우선 master). 본 문서는 그 안에서의 **wire 포맷 교정**이다.
- 관련 메모: 활성기간(0061, `b98e5d1`)이 두 번째 플로팅-UNTIL 지점을 추가함.

## 1. 문제 (관찰된 증상)

동기화된 주간 루틴 `얼라방 금요일 외롭지 않은 모임`(weekly/`["fri"]`, 22:00, duration 120,
`google_event_id=j9dbgtq9m2kfkb`)을 편집하면:

```
ERROR HTTP 400 (응답 194B) code=calendar.terminal kind=Terminal
ERROR 루틴은 저장됐지만 Google 동기화에 실패했습니다 — 설정에서 재시도 (HTTP 400 (응답 194B))
      code=routine.sync.patch_failed kind=Terminal
```

로컬은 저장되지만(`duration_min=120` DB 확인) Google 전파가 400으로 죽어 "제대로 적용 안 됨".

## 2. 근본 원인 (확정)

반복 이벤트는 `start.dateTime`(offset 없는 wall-clock) + `start.timeZone="Asia/Seoul"`로 나간다
(`calendar/write.rs:36`). **RFC 5545 §3.3.10 + Google Calendar API**: DTSTART가 timeZone 참조를
가지면 RRULE의 `UNTIL`은 **반드시 UTC**(`...Z`)여야 한다(Google 문서 예시 `UNTIL=20110701T170000Z`).

그러나 코드는 `UNTIL`을 로컬 wall-clock(`format_dtstart` → `YYYYMMDDTHHMMSS`, **Z 없음**)으로 만든다:

- `routines/rrule.rs:246` — 활성기간 종료(`window_end`).
- `commands/routines/google_sync.rs:411` (`cap_recurrence_before` ← `until_for_previous_day`) — 시리즈 분할 cap.

`얼라방` 편집 → "당일 이후로 적용" 분할 → 옛 마스터를 `UNTIL=20260625T220000`(플로팅)으로 PATCH
→ Google 400. 올바른 값: `UNTIL=20260625T130000Z` (22:00 KST = 13:00 UTC).

`rrule.rs:243` 주석("Google은 TZID 이벤트에서 이 local UNTIL을 수용한다")은 **검증 안 된 잘못된 전제**.

### 왜 테스트가 못 잡았나

단위 테스트는 `RecordingProvider`/`MockGoogle` mock이라 페이로드를 **기록만** 하고 Google RRULE
규칙으로 검증하지 않는다. 즉 분할-편집 경로는 실 Google에선 한 번도 성공한 적이 없을 가능성이 높다.
→ 본 설계의 핵심 방어: **wire 포맷을 단위 테스트에서 못박는다**.

## 3. 시나리오 매트릭스 (같은 결함, 여러 증상)

| 작업                                   | 플로팅 UNTIL?                  | 결과                                               |
| -------------------------------------- | ------------------------------ | -------------------------------------------------- |
| 편집(분할) `update_routine`            | **항상**(옛 마스터 cap)        | 동기화된 반복 루틴 **모든 편집** 400 ← 보고된 버그 |
| 활성기간 종료일 — enable/move/오늘빼기 | end_date 있으면                | 종료일 가진 루틴은 그 작업 전부 400                |
| enable (종료일 없음)                   | 없음                           | 정상                                               |
| disable / 삭제 (DELETE)                | 없음                           | 정상                                               |
| 오늘 빼기 EXDATE (종료일 없음)         | 없음(EXDATE는 `;TZID=`라 적법) | 정상                                               |

단 하나의 결함(플로팅 UNTIL)을 **단일 경계에서** 고치면 위 전부가 적법해진다.

## 4. 설계

### 4.1 유지(안 바꾸는 것)

분할=편집("앞으로만 적용"), EXDATE(`;TZID=`), DTSTART floor, 활성기간 floor, stale-mirror sweep
(404→NULL), bounded retry, ADR-0005 PATCH-우선. **전부 이미 옳다.** DTSTART는 그대로 floating +
`timeZone`(적법). 분할은 Google의 "이 일정 및 향후 일정" 정석이며 사용자가 원하는 의미와 일치.

### 4.2 변경: UNTIL을 만드는 단일 개념을 UTC로

`chrono-tz` 의존성 추가 후 `routines/rrule.rs`에 순수 헬퍼 신설:

```rust
/// 로컬 wall-clock(date 'YYYY-MM-DD' + time 'HH:MM' | None=09:00) + IANA tzid
/// → RRULE UNTIL용 UTC compact 'YYYYMMDDTHHMMSSZ'. tzid 미인식/부재 로컬시각은 RRuleError(fail-closed).
pub fn until_utc(date_ymd: &str, time_hm: Option<&str>, tzid: &str) -> Result<String, RRuleError>
```

플로팅 UNTIL을 만들던 **두 지점**을 이 헬퍼로 일원화:

- `rrule.rs` `window_end` 분기: `format_dtstart(...)` → `until_utc(end, input.time_of_day, input.tzid)`.
- `google_sync.rs::until_for_previous_day`: `tzid` 인자 추가 → `rrule::until_utc(prev_day, time_of_day, tzid)`.
  호출처 `split_routine_sync_after_edit_with_provider`가 `tzid`를 이미 보유 → 스레드만 한다.

`DTSTART`/`EXDATE`/duration 표현은 무변경(이미 적법).

### 4.3 DST/모호 시각 안전 (chrono-tz 채택 근거)

`tz.from_local_datetime(naive)`의 `LocalResult` 처리:

- `Single(dt)` → 그대로 UTC 변환.
- `Ambiguous(earliest, _)`(가을 fold) → `earliest` 채택(표준 선택, 결정적).
- `None`(봄 gap, 존재하지 않는 로컬시각) → `RRuleError`로 **fail-closed**(panic 0).
- `Tz::from_str(tzid)` 실패 → `RRuleError`로 fail-closed.

KST는 DST가 없어 항상 `Single`이지만, 일반 IANA 존에서도 panic 없이 정확.

## 5. 테스트 전략 (mock이 못 잡던 것을 wire 레벨에서 고정)

- `until_utc("2026-06-25", Some("22:00"), "Asia/Seoul") == "20260625T130000Z"` — 정확한 UTC 값.
- `until_utc("2026-06-25", None, "Asia/Seoul") == "20260625T000000Z"` — 09:00 fallback? → `20260625T000000Z`(09:00 KST=00:00 UTC).
- `routine_to_rrule` `window_end` → rrule이 `;UNTIL=...Z`로 끝남(기존 테스트 31/32/34/36의 기대값을 Z로 갱신).
- **DST 존 일반성 증명**: `until_utc(여름날, time, "America/New_York")`(EDT, UTC-4) vs `until_utc(겨울날, …)`(EST, UTC-5) — 오프셋이 계절에 맞게 다름을 단언(chrono-tz 채택 이유를 테스트로 못박음).
- 분할 경로(`google_sync` 테스트): `cap_recurrence_before` 후 RRULE의 UNTIL에 `Z` 존재.
- `rrule.rs:243`/`242`의 잘못된 주석을 정확한 규칙으로 교체.

## 6. 일부러 미루는 것 (한 PR = 한 관심사)

- **메타데이터만 바뀐 편집(제목만)도 현재는 분할**해서 매 편집마다 Google event id 회전 →
  사용자가 Google에 단 알림/위치 등 메타 유실. 별개 개선(스케줄 변경 감지 → 변경 없으면 in-place
  summary PATCH). follow-up.
- **이미 깨진 `얼라방` 복구**: 코드 픽스 후 그 루틴을 한 번 더 저장하면 분할이 정상 전파(추가 작업
  불요). 토글 off→on도 가능.
- **tzid 전역 외부화(PR 2c)**: 현재 `TZID_DEFAULT="Asia/Seoul"` 하드코딩. chrono-tz 도입으로
  외부화 시 `until_utc`는 그대로 동작 — 별도 tz 감사 결과를 `docs/decisions.md`에 기록.

## 7. 검증

- `cargo test`(신규 wire 테스트 포함) + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`.
- `bindings.ts` drift 0(IPC 시그니처 무변경).
- 작성과 **분리된** reviewer 패스(critic)로 INVARIANT #2/#5/#7 점검 — self-approve 안 함.
- 라이브 스모크(앱에서 `얼라방` 재편집 → Google 반영)는 사용자/cmux.
