# 설계: `signal_store` 데이터 접근 레이어 (백로그 F)

> 상태: 승인됨 (2026-05-23 brainstorming). 다음 단계 = writing-plans로 구현 계획 수립.
> 정본 규칙: `AGENTS.md` · `PLAN.md §1`(INVARIANTS) · `docs/architecture.md`.
> 후속: 이 설계는 백로그 G(`signals` god-table 분리)의 선행 작업이다 — F가 signals SQL을
> 한곳에 모아 G의 변경 표면을 줄인다.

## 1. 목적 / 동기

`signals` 테이블 SQL이 IPC 커맨드 핸들러 ~13개 모듈에 흩어져 있다(`signals.rs`, `today/*`,
`retro.rs`, `pr_radar.rs`, `notion.rs`, `agents/{enrich,triage,mod}.rs`, `projects.rs`,
`shared.rs`). 결과: 영속 로직이 커맨드 레이어에 누수, SQL 경로 직접 테스트 곤란, 대형 파일.

**1순위 동기(driver): 백로그 G 준비.** G는 `signals`를 위성 테이블로 분리하는 마이그레이션이다.
signals 컬럼(특히 `today_for_date`/`today_rank`/`today_done_at`/`impact_high`/`regret`)에 대한
모든 접근이 흩어져 있으면 G가 다수 콜사이트를 동시에 고쳐야 한다. F가 그 접근을 `signal_store`
하나로 모으면 G는 store 내부만 바꾸면 된다.

**범위(scope): `signal_store` 하나만.** 다른 aggregate store(agent_runs, routines, projects,
notification 등)는 이 작업 범위 밖이며 추후 별도로 다룬다.

## 2. 비목표 (Non-goals / YAGNI)

- 다른 테이블의 store화(agent_runs/routines/projects…) — 범위 밖.
- 동작 변경·스키마 변경·쿼리 최적화 — **없음**. 순수 relocation. (스키마 변경은 G에서.)
- trait/mock 추상화 — 거부. DB 테스트는 in-memory SQLite(`fresh_db()`)로 이미 가능하므로
  store는 외부 I/O가 없어 fake가 불필요(코드베이스 선례: trait seam은 Notion/GitHub/Calendar/codex
  같은 _외부_ I/O에만 도입).

## 3. 접근 (Approach A — 그대로 이전)

`signals` 테이블/`signals_fts`를 건드리는 모든 `sqlx` 호출을 **동일 SQL·시그니처·반환타입 그대로**
`signal_store`의 `pub(crate) async fn`으로 이전한다. 커맨드는 호출만 남긴다.

대안 B(primitive/composition 분리)·C(trait)는 검토 후 기각: B는 판단/churn이 크고 행위 보존 증명이
어려워짐, C는 과잉(위 비목표 참조). A는 행위 보존(bindings.ts 빈 diff)이 가장 쉽고 G 전 최소 위험.

## 4. 아키텍처

### 4.1 위치 / 모듈

- 신규 `src-tauri/src/commands/signal_store.rs` — `pub(crate)` free fn 모음. `signals` + `signals_fts`
  접근의 **단일 소유자**. `commands/mod.rs`에 `mod signal_store;` 등록(필요한 항목만 `pub(crate)`).
- `SIGNAL_COLS`(현재 `commands/shared.rs`)를 `signal_store`로 이전(자연스러운 home). `shared.rs`의
  다른 소비자가 있으면 `signal_store::SIGNAL_COLS`를 참조하도록 갱신.
- 소비자(signals/today\*/retro/pr_radar/notion/enrich/triage/projects/agents)는
  `use crate::commands::signal_store;` 후 `signal_store::fn(...)` 호출.

### 4.2 함수 표면 (범주별, 그대로 이전)

- **코어 CRUD/dedup:** `insert_signal` · `fetch_signals` · `set_quadrant` · `classify_*` 코어 ·
  `set_signal_status` · `delete_signal` 코어 · `insert_promotion_draft` · title/dedup_key 갱신 · FTS 매칭.
- **Today 레일:** `promote_today_inner` · `unpromote_today_inner` · `toggle_today_done` 코어 ·
  `reorder_today` 코어 · `fetch_today` (`today_for_date`/`today_rank`/`today_done_at`).
- **집계(signals-primary):** overview의 Work Debt 카운트 SELECT · weekly throughput SELECT 중
  signals 중심 쿼리.
- **회고:** `impact_high`/`regret` 태깅 · archive/restore · completed-in-range.
- **PR/외부:** `upsert_pr_signal` · `auto_resolve`(signals status 갱신) · notion 승격 status/links
  연결 · `set_signal_area` · suggested_quadrant 갱신.

> 정확한 함수 목록·시그니처는 writing-plans 단계에서 콜사이트별로 확정한다(이 설계는 경계와 규칙을 정함).

### 4.3 경계 규칙 (무엇이 store로 가고 무엇이 남나)

- 쿼리의 `FROM`/`JOIN`이 **signals 중심**이면 store fn으로 이전.
- 순수 _타 테이블_ 쿼리, 그리고 교차 집계(예: today overview가 `debt_snapshots` 조인, weekly가
  routines 조인)의 **비-signals 부분**은 커맨드에 잔류하고 store fn을 호출.
- 로직 결합 쿼리(예: `pr_radar.rs`의 `auto_resolve` 루프)는 **쿼리만** store로 이전하고 루프/제어
  흐름은 커맨드에 잔류.

## 5. 행위 보존 (검증 = 증거)

- **SQL 무변경**(순수 relocation): 같은 파라미터·바인딩·반환타입.
- `git diff --exit-code src/bindings.ts` **빈값** — 커맨드 시그니처 유지(위임만) → IPC 표면 동일.
- `cargo test --lib` 기존 테스트 통과(커맨드 경유로 이전된 SQL을 그대로 검증).
- **signal_store 직접 단위테스트 추가** — 플랜의 testability 목표. 테스트 *수 증가*는 허용(행위
  변경 아님, 신규 커버리지).
- `cargo clippy --all-targets -- -D warnings` 0 · `cargo fmt --check` green.
- **critic 패스(self-approve 금지)**: INVARIANT #3(dedup upsert + auto-resolve 보존)·#7(SQLite
  SSOT)·#1(결정 레일 — quadrant/classification 무변경, store는 기계적) 확인.

## 6. PLAN Phase 승격

F+G를 신규 **Phase 21 — Signals 영속 레이어(F) + god-table 분리(G)**로 `PLAN.md`에 승격.

- **F(이 설계):** signal_store 1 PR(원자적). Done = §5 전 항목 green + critic ACCEPT.
- **G(별도 spec):** `signals` 분리 마이그레이션 + 위성 테이블 + 데이터 보존 테스트 + signal_store
  내부 변경. F 머지 후 별도 brainstorming/spec.

## 7. 시퀀싱

1. **PR1 (F):** `signal_store` 신설 + `SIGNAL_COLS` 이전 + 전 소비자 위임. 원자적 단일 PR.
   검증(§5) + critic → `dev` `--ff-only` 머지 → push.
2. **이후 G:** 별도 brainstorming → spec → 마이그레이션 PR(들).

## 8. 리스크 / 완화

| 리스크                                            | 완화                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| 대형 단일 PR(~13파일 위임 변경)                   | verbatim SQL(로직 무변경) + `bindings.ts` 빈 diff + critic                   |
| `SIGNAL_COLS`/`WorkSignal` 매핑 어긋남            | 컬럼 상수·FromRow 매핑 그대로 이전, 회귀 테스트                              |
| 로직 결합 쿼리(auto_resolve 등) 분리 시 동작 변화 | 쿼리만 이전, 루프/제어는 커맨드 잔류; 기존 테스트로 가드                     |
| store가 또 다른 god-module화                      | 현재 god-table(signals) 1:1 미러. G가 테이블을 쪼개면 store도 후속 분할 여지 |

## 9. 미해결(구현 계획에서 확정)

- store 함수의 정확한 목록/이름/시그니처(콜사이트 인벤토리).
- `classify_signal`/`set_signal_status` 등 일부가 커맨드 로직과 얼마나 결합됐는지 — 쿼리/로직 분리선.
- `shared.rs`의 `SIGNAL_COLS` 외 다른 공유 항목이 signals 전용인지(같이 이전할지).
