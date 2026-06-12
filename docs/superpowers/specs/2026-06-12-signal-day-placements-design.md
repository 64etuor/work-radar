# Signal Day Placements — 브레인덤프 카드 carry-over · 일별 배치 · 누적 시간 집계

- **Date**: 2026-06-12
- **Status**: Approved (user, 2026-06-12)
- **Areas**: data-layer (`docs/areas/data-layer-conventions.md`), today-timeline (`docs/areas/today-timeline.md`), frontend-board (`docs/areas/frontend-board.md`)

## 문제

브레인덤프 카드를 Today에 올리면 미완료 carry-over는 동작하지만(`signals.today_done_at IS NULL` 롤오버), 타임라인 **배치**가 `signals.scheduled_at` + `scheduled_duration` **카드당 단일 값**이라:

1. 어제 14:00에 배치했던 미완료 카드는 오늘 타임라인에 안 보이고(블록은 `localDateOf(scheduledAt)`로 그 날짜에 스코프), 미배치 트레이(`scheduled_at IS NULL`만 표시)에도 안 떠서 **오늘 다시 배치할 수 없다**.
2. 오늘 다시 배치하면 어제 배치를 **덮어써** "어제 1h + 오늘 2h = 총 3h" 같은 **누적 시간 집계가 구조적으로 불가능**하다.

## 요구사항 (사용자 확정)

| 항목          | 결정                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 집계 기준     | **배치된 블록 시간 합산** (별도 타이머 없음, 배치 = 시간 사용으로 간주)                                                           |
| Carry-over UX | 미완료 카드는 **그 날짜에 배치가 없으면 미배치 트레이로 복귀**, 사용자가 직접 재배치 (자동 복제 없음 — 사용자=유일한 결정자 원칙) |
| 하루 블록 수  | **하루 1블록** (`UNIQUE(signal_id, date)`; N블록은 후속 확장 가능)                                                                |
| 집계 표면     | **둘 다** — 카드 배지("누적 3h · 3일째") + Weekly Review 시간 합산 섹션                                                           |

## 선택한 접근 (대안 비교)

- **A. 날짜별 배치 테이블 (채택)** — `signal_day_placements(signal_id, date, …)`. 루틴의 `routine_checks(routine_id, date)` 패턴을 시그널에 적용. 날짜별 1행이라 carry-over/재배치/집계가 전부 자연스럽게 나옴.
- B. 로그 테이블 부착 — `scheduled_at` 유지 + 과거 배치 스냅샷. SSOT가 둘로 갈라지고 스냅샷 시점(앱 미실행일) 경계 사례가 지저분해 기각.
- C. 누적 카운터만 — 날짜별 내역이 없어 Weekly 영역별 집계 불가, 수정 불가. 요구사항 미충족으로 기각.

## 설계

### 1. 데이터 레이어 — 마이그레이션 `0050_signal_day_placements.sql`

```sql
CREATE TABLE signal_day_placements (
  id          TEXT PRIMARY KEY,
  signal_id   TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,            -- YYYY-MM-DD (local)
  start_at    TEXT NOT NULL,            -- 기존 scheduled_at과 동일 포맷 (블록 빌더가 localDateOf로 스코프하는 ISO)
  duration_min INTEGER NOT NULL,        -- 분
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(signal_id, date)
);
```

- **백필**: 기존 `signals.scheduled_at IS NOT NULL AND scheduled_duration IS NOT NULL`인 행을 `date = localDateOf(scheduled_at)`로 1행씩 삽입. 백필의 local 날짜 변환은 기존 블록 빌더와 동일한 규칙을 따른다(UTC↔local 경계 주의 — 구현 시 기존 저장 포맷을 먼저 확인하고 동일 규칙 적용).
- 기존 `signals.scheduled_at/scheduled_duration` 컬럼은 **드랍하지 않고 읽기/쓰기 중단**(deprecated). 정리 마이그레이션은 별도 후속.
- 스키마 변경은 마이그레이션으로만, 멱등 + 데이터 손실 테스트 포함 (`docs/areas/data-layer-conventions.md`).

### 2. Rust 커맨드 (`src-tauri/src/commands/today/`)

- **배치/리사이즈/해제**: `(signal_id, date)` 기준 upsert/update/delete로 전환. 배치 upsert는 `ON CONFLICT(signal_id, date) DO UPDATE` (dedup upsert 관례).
- **`fetch_today(date)`**: 기존 롤오버 필터(`today_done_at IS NULL OR today_done_at = ?date`)는 그대로 두고, 그 날짜의 placement를 LEFT JOIN해 반환. placement 없음 = 트레이 대상.
- **신규 집계 쿼리**:
  - 카드별: `SELECT signal_id, SUM(duration_min), COUNT(*) FROM signal_day_placements GROUP BY signal_id` (+ 필요 시 today 대상 카드로 스코프) → 카드 배지용.
  - Weekly: 기간(`date BETWEEN ?start AND ?end`) × signal `area`/`kind` join 합산 → Weekly Review용.
- 신규 PK/카운트 정수는 **i32** (specta i64 금지). 커맨드 추가/변경 후 `cargo test`로 `src/bindings.ts` 재생성 — drift는 CI 게이트.
- 에러는 `AppError` envelope, `Result<_, AppError>`로 IPC 경계.

### 3. 캘린더 미러 (결정)

- `signals.linked_event_id/linked_calendar_id`는 **카드당 1개 유지**. Google 미러 이벤트는 **최신 배치를 따라 이동**(오늘 재배치 시 reschedule). 과거 날짜의 Google 이벤트 이력은 보존하지 않는다 — 누적 집계의 SSOT는 로컬 `signal_day_placements` (INVARIANT #2: Google=read cache + write-through, #7: SQLite=SSOT).
- `calendar_sync.rs`의 시그널 reschedule staging 경로가 placement upsert를 호출하도록 전환. 루틴 adoption 경로(`routine_checks` 링크)는 무변경.

### 4. 프런트엔드

- **`src/lib/todayBlocks.ts`**: 시그널 블록을 "보고 있는 날짜의 placement"로 생성 (`signal.scheduledAt` 단일 값 → 날짜별 placement 입력으로 교체). done 표시(취소선/opacity)는 기존 `todayDoneAt` 그대로.
- **`UnscheduledTray.tsx`**: 표시 조건을 `scheduledAt == null` → "**그 날짜의** placement 없음"으로 변경. 이것만으로 어제 배치했던 미완료 카드가 오늘 트레이에 자동 복귀.
- **`useTimelineDnd.ts`**: 트레이→캔버스 드래그 = 그 날짜 placement upsert. 블록 이동/리사이즈 = 그 날짜 placement update. 캔버스 밖으로 = 그 날짜 placement delete.
- **카드 배지**: Today 레일/트레이 카드에 `누적 {X}h · {N}일째` 배지. N일째 = 기존 age 공식 `(today − today_for_date) + 1` 재사용, 누적 시간 = 집계 쿼리.
- **Weekly Review**: 시간 합산 섹션 추가 — 기간 총합 + 영역(area)별 분해. 같은 Weekly 집계 쿼리 재사용. 시각 규칙은 `DESIGN.md` 토큰 준수.

### 5. 테스트

- Rust: placement upsert 멱등성, `UNIQUE(signal_id, date)` 충돌 경로, 백필 마이그레이션(기존 scheduled_at → 행 생성, 날짜 경계 포함), `fetch_today` join, 집계 쿼리(다일 합산·기간 경계), 기존 롤오버 테스트(`completed_today_item_does_not_roll_over`) 유지/갱신.
- 프런트(vitest): `buildTodayBlocks` 날짜별 placement 스코프, 트레이 필터(어제 배치 + 오늘 미배치 = 트레이 표시), 배지 포맷.
- 게이트: `cargo test` + clippy `-D warnings` + fmt / `pnpm typecheck` + lint + vitest / bindings drift 0 (`docs/reference/commands.md`).

## 영향 범위 요약

| 레이어   | 파일                                                                                    | 변경                                   |
| -------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| DB       | `src-tauri/migrations/0050_*.sql`                                                       | 신규 테이블 + 백필                     |
| Rust     | `commands/today/` (store/배치 커맨드), `calendar_sync.rs`                               | 배치 경로 전환 + 집계 쿼리 신규        |
| Bindings | `src/bindings.ts`                                                                       | 재생성 (자동)                          |
| FE       | `todayBlocks.ts`, `UnscheduledTray.tsx`, `useTimelineDnd.ts`, Today 카드, Weekly Review | placement 기반 전환 + 배지 + 집계 섹션 |

## 리스크 · 롤백

- **캘린더 sync 회귀**: `calendar_sync.rs`는 최근 adoption 트랙과 같은 파일 — 시그널 경로만 건드리고 루틴 경로 무변경을 테스트로 고정.
- **백필 날짜 경계**: 저장 포맷(local vs UTC)을 구현 첫 단계에서 실제 데이터로 확인 후 변환 규칙 결정.
- **롤백**: 기존 컬럼을 드랍하지 않으므로, 코드 리버트만으로 구버전 동작 복원 가능(새 테이블은 무해하게 잔존).

## 명시적 비범위 (YAGNI)

- 실제 소요 시간 타이머 / actual vs planned 구분
- 하루 N블록 분할 배치 (스키마는 UNIQUE 제거로 확장 가능)
- 자동 재배치(어제 시간대 복제), 오래된 카드 자동 아카이브 임계값
- 과거 Google 이벤트 이력 보존
- `scheduled_at/scheduled_duration` 컬럼 드랍 (후속 정리)
