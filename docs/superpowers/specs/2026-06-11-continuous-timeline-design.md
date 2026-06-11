# Today 타임라인 연속화 (continuous scroll + lazy load) — 설계 스펙

날짜: 2026-06-11
상태: 설계 승인됨 (구현 전)
범위 도메인: `src/components/today/**`, `src/lib/timelineLayout.ts`, `src/lib/todayBlocks.ts` → `docs/areas/frontend-shell.md` + `DESIGN.md`

## 0. 문제

Today(운영) 타임라인은 엄격한 달력일(00:00–23:59) 창이라, 자정을 넘겨 일하는 날
타임라인이 단절된다. 또한 자정을 걸치는 블록(예: 23:00–01:30)은 `toMin()`이 날짜를
버리는 탓에 duration이 음수가 되어 **양쪽 날짜에 20px 슬리버로 잘못 렌더**되는
기존 버그가 있다 (`src/lib/timelineLayout.ts:47`).

## 1. 결정 (사용자 확정)

| 질문           | 결정                                                                               |
| -------------- | ---------------------------------------------------------------------------------- |
| 원하는 UX      | **연속 스크롤 타임라인** (어제↔오늘↔내일이 한 축, 인접 날짜 lazy load)             |
| 자정 걸침 블록 | **하나의 연속 블록** (경계 분할 렌더 아님)                                         |
| 연속화 범위    | **타임라인만**. 신호 레일·루틴 목록·KPI는 기존 `date` state 유지                   |
| 로딩 전략      | **무한 양방향 lazy load + 초기 스크롤은 현재시각 센터**                            |
| 구현 접근      | **A: 연속 분(minute) 축 + 날짜별 lazy fetch** (세그먼트 스택·외부 라이브러리 배제) |

## 2. 좌표계 — 절대 분(minute) 축

핵심 변경. 앵커 날짜(로드된 가장 이른 날) 00:00 기준 절대 분:

```
absMin(iso, anchorDate) = dayDiff(localDateOf(iso), anchorDate) × 1440 + h×60 + m
```

- `dayDiff`는 날짜 문자열(YYYY-MM-DD) → `Date.UTC(y,m,d)` 산술. `new Date(iso)`
  재파싱 금지(UTC 변환 자정 off-by-one — 기존 `localDateOf` 주석과 동일 근거).
- `computeLayout(blocks, anchorDate)` 시그니처에 anchor 추가. 클러스터링/그리디
  컬럼 할당 알고리즘은 무변경, 순수함수 유지.
- 자정 걸침 블록은 duration이 양수가 되어 슬리버 버그가 별도 분기 없이 근본 해결.

## 3. 데이터 — per-day 버킷 유지 + 프런트 병합/dedup

fetch 단위는 기존 per-day를 유지한다 (`["calendarEvents", date]`, `["routines", date]`).
기존 캐시 키·persist allowlist·optimistic 패치 경로·Rust TTL 캐시가 전부 그대로 산다.

- `visibleDates[]`(로드된 날짜 목록) state + `useQueries`로 날짜별 events/routines 조회,
  `buildTodayBlocks`를 날짜별 실행 후 병합.
- **dedup**: 자정 걸침 이벤트는 구글 overlap 시맨틱상 인접 두 윈도우 양쪽에서 온다.
  블록 id(`event:${calendarId}:${id}` 복합키)로 dedup, full span 1개 채택.
- signals: 단일 쿼리에 여러 날짜가 섞여 오므로 날짜 필터를 `= date`에서
  `∈ loadedRange`로 확장, id당 1회 렌더.
- 렌더 위치는 캐시 버킷이 아닌 ISO에서 유도 — optimistic 패치는
  `setQueriesData(["calendarEvents"])` predicate로 로드된 모든 버킷 순회.
- lazy load: 스크롤이 상/하단 1일 이내 접근 시 날짜 prepend/append. 날짜당 fetch 1회.
  DOM 마운트는 보이는 날짜 ±1일 윈도잉(블록 레이어), 캐시는 react-query gcTime 위임.
- **prepend 스크롤 앵커링**: 위로 날짜 추가 시 `scrollTop += 1440px` 보정 필수.

## 4. 렌더 — TimelineCanvas 멀티데이

- 컨테이너 높이 = `loadedDays × 1440px`. 각 날짜 00:00에 날짜 separator
  (sticky 라벨, 예: "6월 12일 (목)"). 시간 라벨·업무시간 음영(09–18)은 날짜별 반복.
- now 라인: `absMin(now)` 절대 위치 1개. `date === today` 조건 제거 — 자정 롤오버 시
  자연히 다음 날 구간으로 이동.
- 초기 스크롤: 현재시각 센터. 헤더 날짜 네비게이션(◀ ▶)은 "해당 날짜로 스크롤"로
  의미 변경. 레일·루틴·KPI는 기존 `date` state 그대로(비연속).

## 5. DnD — 좌표계 추종 (`useTimelineDnd.ts`)

- `pixelToLocalIso(anchorDate, absY)`: `date = anchorDate + floor(absMin/1440)`,
  `time = absMin % 1440`. 클램프는 로드된 범위로.
- `shiftIsoByPx`/`resizeIsoByPx`: startISO의 절대 분 기준 delta — 자정 넘는
  드래그/리사이즈 자동 가능. `24*60 - SNAP` 클램프 제거.
- `resolveCanvasGridY` 클램프 `24*HOUR_PX` → `loadedDays*24*HOUR_PX`.
- `tzOffset()`: "지금" 오프셋을 모든 날짜에 적용 중 → **대상 날짜의** 오프셋으로
  계산 (KST 무변화, DST 지역 정합).
- **루틴 블록 예외**: `routine_checks`는 `date + time_override(HH:MM)` 구조라
  다음 날 새벽을 표현 불가 → 루틴 DnD는 자기 occurrence 날짜 안으로 클램프
  (경계 스냅). 스키마 확장은 의도적 deferred.

## 6. 구글 동기화 — 영향 없음 (확인 완료)

- 읽기: per-day `today_window`(`src-tauri/src/calendar/windows.rs:4`) 호출 유지.
  구글 API는 `timeMin/timeMax + singleEvents=true`로 윈도우와 겹치는 이벤트를
  full start/end로 반환 — 자정 걸침 이벤트는 양쪽 날짜 fetch에 모두 내려오며
  잘리지 않는다 (§3 dedup이 처리).
- 쓰기: sync 워커(`src-tauri/src/calendar/sync.rs`)는 RFC3339 패스스루 — 날짜
  경계 개념 없음. `eventReschedule`로 날짜가 바뀌어도 같은 `events.patch`.
  staged moveCalendar(INVARIANT #2 게이트) 무변경.
- **Rust 코드 변경 0, 마이그레이션 0, bindings drift 0** (검증으로 확인).

## 7. 영향 평가 (전수)

| 파일                                      | 변경                                             | 위험                              |
| ----------------------------------------- | ------------------------------------------------ | --------------------------------- |
| `src/lib/timelineLayout.ts`               | `toMin` 날짜 인지 + anchor 파라미터              | 낮음 (순수함수)                   |
| `src/lib/todayBlocks.ts`                  | 날짜별 빌드→병합·dedup, signal 범위 필터         | 중간 (dedup 누락=중복 블록)       |
| `src/components/today/useTimelineDnd.ts`  | 좌표 함수 4곳 + 클램프 + 캐시 패치 predicate     | **최고** (7개 인터랙션 회귀 가능) |
| `src/components/today/timelinePreview.ts` | `date` → anchor 전달                             | 낮음                              |
| `src/components/today/TimelineCanvas.tsx` | 멀티데이 그리드·separator·now라인·윈도잉         | 중간 (prepend 앵커링)             |
| `src/components/TodayView.tsx`            | `visibleDates` state·useQueries 병합·스크롤 관리 | 중간                              |
| `src/lib/query/calendar.ts`               | 무변경 또는 thin 헬퍼                            | 낮음                              |
| CSS (`today-*`)                           | separator/sticky 라벨                            | 낮음                              |
| 테스트 3종 (layout/blocks/preview)        | anchor 반영 + 신규 케이스                        | —                                 |

무영향 확인: `CalendarDrawer`(자체 range 훅), `CaptureBoard`, `EventPopover`,
`TimelineBlock`(표시 전용), Rust 전체. 스펙 §8.5("멀티데이 블록 범위 밖") 문구 갱신 필요.

## 8. 엣지 케이스 & 테스트 계획

신규 vitest:

1. 자정 걸침 이벤트 → 단일 연속 블록(양수 duration, 경계 가로지름)
2. 인접 윈도우 중복 이벤트 dedup (full span 1개)
3. 자정을 가로지르는 클러스터의 컬럼 폭 일관성
4. DnD 자정 통과 ISO 산출 (날짜 증가 확인)
5. 루틴 occurrence 날짜 경계 클램프
6. prepend 시 기존 블록 top + 1440px 보정

회귀: 기존 단일일 케이스 전부 anchor=해당일로 통과 유지.
검증 게이트: `docs/reference/commands.md` 정본 (typecheck/lint/vitest + tauri dev 부팅).

## 9. 의도적 deferred

- 루틴의 자정 걸침 표현 (`routine_checks` 스키마 확장 필요 — 별도 트랙)
- 레일/루틴 목록의 스크롤 추종 날짜 네비게이션 (뷰 전체 연속화)
- 주/월 뷰(`range_window`)와의 연속 축 통합
