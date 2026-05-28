# Data Layer Conventions

## sqlx + SQLite + WAL

- `sqlx 0.8`, sqlite (bundled libsqlite3-sys, FTS5 포함).
- `db.rs`: pool (max 5) + `WAL` + `busy_timeout=5000` + `synchronous=Normal` (PRAGMA 검증 테스트 보유).
- 트레이드오프: `-wal`/`-shm` 부산물; synchronous=Normal은 크래시 시 마지막 트랜잭션만 손실 가능
  (로컬 상태 DB라 수용).

## Migrations only — 임의 ALTER 금지

- 모든 스키마 변경은 `src-tauri/migrations/NNNN_name.sql` 파일로만.
- 현재 0001..0022 적용 중. 새 번호는 +1, 한 PR=한 마이그레이션 원칙(섞으면 롤백 비용↑).
- 마이그레이션은 멱등(idempotent) 보장 테스트 추가(news 0019 선례).
- 데드 컬럼 제거도 마이그레이션(예: 0015 `remove_ticket_key_pattern`, 0008 `remove_mismatch`).

## SSOT 분리 (INVARIANT #7)

- **Notion** = 백로그/안건 *내용*의 SSOT. 로컬 미러는 read cache + write-through.
- **SQLite** = 매트릭스 상태·신호·승격 이력·에이전트 잡·옵션·뉴스의 SSOT.
- API rate limit (Notion 3 req/s, GitHub octocrab) + pagination 준수. bounded retry.
- 오프라인 우선: 네트워크 불가 시 UI 무차단, 승격은 큐잉 후 reconcile.

## Dedup upsert (INVARIANT #3)

- 폴링이 만드는 신호는 `dedupKey`로 **upsert**(append 아님). 매 cycle 중복 카드 방지.
- braindump는 `braindump:{lower(공백정리(title))}`로 dedup → 같은 입력이면 touch만.
- 원인 해소 감지(CI 통과, Notion 상태 일치) 시 신호 auto-resolve.
- PR Radar는 현재 표시 전용 — escalation 경로 없음(`docs/areas/frontend-shell.md`
  "PR Radar 제약" 참조). 재도입은 INVARIANT #4 임계치 정책을 ADR로 정한 뒤.

## FTS5

- `signals_fts` external-content 가상 테이블 + insert/delete/update 동기화 트리거.
- 새 검색-가능 컬럼 추가 시 트리거도 함께 마이그레이션해야 한다.
- 본문/제목 매칭 테스트(`search_signals` 커맨드)로 회귀 방지.

## Repository / Store 패턴 (F-series)

소유자 없던 cross-cutting 테이블을 단일-소유 store로 추출:

- `commands/signal_store.rs` — signals + signals_fts (모든 SQL 단일 소유).
- `commands/agent_run_store.rs` — agent_runs + acceptances (Acceptance 게이트 단일 감사 지점).
- `commands/notification_store.rs` — scheduled_notifications (generic source/source_id API).

패턴(공통):

- verbatim 이전 (`pub(crate)` free fn, `&Db` 인자, `signal_store` 선례 일관).
- bindings.ts 무변경(순수 이전).
- store 직접 테스트 + critic ACCEPT.

남은 후보: `promotion_store`(~21), `skill_store`(~20), `pr_radar_store`(~11), 소형
(projects/hermes/calendar/retro/nav). **routine_store는 부분 추출만 가능**(today/ 공유 +
delete tx 예외) — notification_store 선행으로 일부 완화.

**G (signals god-table 분리)**: `signal_store`만 의존하므로 F 잔여와 독립 착수 가능.
위성 테이블 분리 = 마이그레이션 + 데이터 보존 테스트 + critic 필수.

## Today 멤버십 = signal 컬럼

- `signals.today_for_date` / `today_done_at` / `today_rank` 컬럼으로 Today 상태 SSOT화
  (migration 0002).
- 매트릭스/미분류 = `today_for_date IS NULL AND status active`.
- Today = `today_for_date NOT NULL AND (today_done_at IS NULL OR today_done_at = 오늘)`.
- Today 승격/완료/되돌리기는 별도 promotion 로그 행 없이 signal 컬럼 토글(로컬 액션, Acceptance 불요).
- backlog/agenda/calendar만 `promotions`에 draft 행을 남긴다.

## 날짜는 프런트가 주입

- SQLite `datetime('now')`는 UTC라 "오늘" 경계가 어긋날 수 있어 promote/list_today/complete/
  routine 커맨드는 프런트 계산 **로컬 날짜(YYYY-MM-DD)**를 인자로 받는다.
- 경과일 `+N = (오늘 − today_for_date) + 1`은 프런트가 계산(`ageFromForDate`).

## Stringly-typed 금지 — 닫힌 enum 사용

- 상태 컬럼은 sqlx `TEXT + CHECK` + Rust enum (`AgentStatus` 등). enum-DB 드리프트 0.
- 내부 JSON 페이로드는 serde 구조체 (jobs `trigger`, PR signal `links`). 키-shape 회귀 테스트 추가.
- **codex proposal(외부)은 문자열 유지** — 외부 schema 보장 없음.

## Acceptance 게이트 SQL

- `record_acceptance`/`reject_run`/`finalize`(`commands/agent_run_store.rs`)에서만 상태 전이.
- byte-equivalent compare-and-swap (critic 검증). 우회 금지.

## Stage timeout / test isolation

- 테스트 임시 DB 경로에 per-call `AtomicU64` (macOS coarse 클록 병렬 레이스 방지).
- 새 store 단위테스트는 임시 DB로 격리.

## 정본 / 참조

- `src-tauri/src/db.rs` — pool, PRAGMA, migration runner
- `src-tauri/migrations/*.sql` — 정본 스키마
- `docs/architecture.md` §4 §6 §7
- `docs/plans/2026-05-23-quality-followups-remaining.md` §2.F — store 진행상태
- `docs/plans/2026-05-23-agent-run-store-{design,impl}.md`
- `docs/plans/2026-05-24-notification-store-{design,impl}.md`
