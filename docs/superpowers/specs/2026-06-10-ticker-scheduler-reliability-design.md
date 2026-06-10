# Ticker Scheduler Reliability — 설계 (2026-06-10)

## 문제

Boule 거버넌스 루프의 유일한 자동 심장박동은 앱 내장 ticker scheduler
(`src-tauri/src/governance/ticker_scheduler.rs`)다. 현재 세 가지 신뢰성 결함이 있다:

1. **스케줄러 생존성이 비가시.** `run_loop`는 fire-and-forget tokio task다. 부팅 시
   `RealTickCommandRunner::resolve()`가 실패하면(`node` 미발견 등) 자동 틱이 **앱 재시작
   까지 영구 비활성**되는데, tracing warn 한 줄 외에는 어디에도 표시되지 않는다. Control
   Room INFRA 바는 boule preflight만 보여주고 앱 스케줄러 자체의 상태는 모른다.
2. **인프라성 tick 실패가 무한 재시도.** `TickStatusOutcome::requires_attention()`은
   거버넌스 결과(halted/needs_human/stalled)만 attention으로 올린다. `SpawnFailed`/
   `Timeout`/`ParseFailed`/`ReadinessFailed`/`InfraFailed`는 attention 없이 interval마다
   영원히 재시도된다 — "bounded retry + terminal failure 노출" INVARIANT 위반.
3. **due-scan 행 단위 에러 삼킴.** `run_due_scan`에서 `tick_project_now_with_runner`가
   `Err`(예: repo 경로 해석 실패)를 반환하면 warn 로그만 남고 행은 무변경 — 역시 무한
   재시도 + 비가시.

## 범위 밖 (의도적 deferred 유지)

- 이벤트-push(폴링 4s 대체), 실 usage/budget 파싱, OS-레벨 cron/launchd — 기존 결정대로
  별도 트랙.

## 설계

### 마이그레이션 `0046_ticker_scheduler_reliability.sql`

- `project_ticker` += `consecutive_failures INTEGER NOT NULL DEFAULT 0`.
- 신규 단일-행 테이블 `ticker_scheduler_status`
  (`id=1` CHECK, `last_wake_at`, `scan_ok`, `runner_ok`, `runner_error`, `fired`).
  앱 스케줄러 하트비트의 SSOT(SQLite = 운영 상태 SSOT, INVARIANT #7과 정합).

### ticker.rs — bounded failure escalation

- `TickStatusOutcome::is_infra_failure()` = SpawnFailed|Timeout|ParseFailed|
  ReadinessFailed|InfraFailed.
- `persist_finalized_tick`: 인프라 실패면 `consecutive_failures += 1`, 성공/거버넌스
  결과면 0으로 리셋. `consecutive_failures >= 3`이 되면 `attention_required = 1`
  (스케줄러 due-scan은 attention 행을 제외하므로 자동 재시도가 **여기서 멈춘다** =
  terminal failure 노출). 수동 tick은 attention과 무관하게 항상 가능(기존 동작 유지),
  성공 시 카운터 리셋 + attention 해제.
- 신규 `record_auto_tick_dispatch_failure(db, project_id, err)`: due-scan `Err` 경로용.
  `last_outcome='spawn_failed'` + error report json + 동일 카운터/에스컬레이션.

### ticker_scheduler.rs — 하트비트 + 자가치유

- 매 wake마다 `ticker_scheduler_status` 단일 행 upsert(`record_scheduler_heartbeat`).
- runner 해석을 부팅 1회 → **루프 내 lazy-resolve(성공 시 캐시)** 로 이동: 부팅 시 node가
  없어도 스케줄러는 살아서 매 wake 재시도하고(자가치유), 그동안 `runner_ok=0` +
  `runner_error`가 하트비트에 기록된다.
- `run_due_scan` `Err` arm → `record_auto_tick_dispatch_failure` 호출(best-effort).

### IPC + Control Room 표면

- 신규 read-only 커맨드 `get_ticker_scheduler_status` →
  `Option<TickerSchedulerStatus>` (camelCase serde + specta; `seconds_since_wake`는
  SQLite `strftime('%s')` 차이로 계산 — 단일 시계). `None` = 한 번도 wake 안 함.
- FE: `useTickerSchedulerStatus()` 4s 폴링. `InfraBar`에 `scheduler` 칩 추가 —
  ok(최근 90s 내 wake & runner_ok) / advisory(stale 또는 미가동) / blocker(runner_error).
- 티커 행 attention 사유 가시화: `consecutiveFailures`를 바인딩에 노출, 티커 패널
  툴팁/표시에 반영.

## 에러 처리

- 하트비트 기록 실패는 warn 로그 후 루프 지속(스케줄러를 죽이지 않음).
- escalation은 SQL 단일 UPDATE로 원자적(카운터 읽기-수정-쓰기 경쟁 없음; in_progress
  잠금 하에서만 호출되는 기존 경로 유지).

## 테스트

- Rust: (a) 인프라 실패 3연속 → attention=1 + due-scan 제외(바운디드 증명),
  (b) 성공 시 카운터 리셋, (c) 거버넌스 attention은 기존대로 1회에 즉시,
  (d) due-scan Err arm이 실패를 기록, (e) 하트비트 upsert 단일 행 유지.
- FE: 칩 톤 헬퍼 순수 함수 단위 테스트.
- bindings drift = cargo test 재생성으로 0 확인.

## 위험/롤백

- 마이그레이션은 가산적(ADD COLUMN + 신규 테이블) — 롤백은 후속 마이그레이션으로.
- 기존 거버넌스 attention 의미 불변; INVARIANT #1(자동화의 결정 레일 침투 금지) 비접촉
  — 스케줄러는 여전히 operator clock일 뿐, 이벤트/결정 쓰기 없음.
