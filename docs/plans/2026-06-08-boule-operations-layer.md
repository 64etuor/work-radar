# Boule Operations Layer — Per-Project Ticker (Control Room auto on/off)

- **Date**: 2026-06-08
- **Author**: claude (Opus) — 2-brain(codex consult, clean CODEX_HOME, read-only). 모든 "이미 있음" 주장은 dev(`5c349a1`) 소스로 검증.
- **Status**: SPEC / 신규 플랜. 구현은 페이즈별 슬라이스(TDD + 별도 critic 패스, codex --yolo 가시 pane).
- **위치 근거**: 이건 **app 운영/런타임 층**(Tauri 스케줄러 + app SQLite + Control Room UI + app→governance CLI 브릿지)이라 repo-root `docs/plans/`. 백엔드-선택 정책 엔진(`governance/docs/plans/2026-06-08-autonomous-coding-master-plan.md`)과 **별개 플랜**(codex E: 완료된 엔진 플랜 밑에 새 리스크 표면 숨기지 말 것).

## 0. 한 줄 요약 / 사용자 확정

**엔진(어떤 모델/예산/누가 완료판정)은 done. 빠진 건 "프로젝트별로 자율 루프를 켜고 끄고 실제로 돌리는 운영 표면"이다.**

사용자 확정(2026-06-08): Control Room에서 프로젝트별로 **ticker(자율 tick 박동)를 on/off** + **진짜 실행 기반**. codex consult로 아키텍처 확정.

### 0.1 용어 정리 (codex B — 네이밍 함정 회피)

- **Ticker / Auto Tick** = 박동(clock)이 도느냐. 신규 운영 플래그. ("auto mode"는 내부 `autoMode`와 충돌 → UI에서 쓰지 않는다.)
- **autonomyLevel** = 박동이 돌 때 _무엇이 허용되나_(manual<dispatch<auto_plan<full). 기존, 별도.
- **둘은 직교.** `tick_enabled=true + autonomyLevel=manual` = 유효하나 inert(tick은 readiness/halt/status만 보고, dispatch 안 함). UI 표기: "Clock on, autonomy manual — waiting for human gates."

## 1. 아키텍처 — 앱이 Operator Clock (INVARIANT #5 준수)

```
[Control Room UI]  ── toggle / interval / "Tick now" ─▶  [Tauri IPC]
                                                              │ (repo path = DB 해소, 렌더러 입력 금지)
                                                              ▼
[app SQLite: project_ticker]  ◀── runner 영속(last_outcome/attention) ──  [Rust Ticker Runner]
        ▲ (enabled/interval/next_due/in_progress/...)                          │ bounded spawn
        │                                                                       ▼
[app-bound bounded scheduler]  ── due row 체크(min interval, no catch-up, no overlap) ─▶  `boule tick --repo X --max-steps N --json`
                                                                                              │ (one bounded heartbeat — governance 엔진은 안 건드림)
                                                                                              ▼
                                                                                  TickReport(JSON) → SQLite 영속
                                                                       halted/stalled/needs_human → attention_required + 자동 tick 억제
```

**핵심 불변 (codex A/D):**

- **cadence는 앱(operator)에, 엔진엔 절대 안 넣는다.** `boule tick` = one bounded heartbeat(이미 있음). 앱은 그걸 **bounded하게 spawn**할 뿐. governance/ 안에 루프 금지.
- **앱 바운드 interval은 데몬이 아니다** — 조건: 앱이 명시적 operator clock(앱 닫히면 정지=명시 UI), 매 tick `--max-steps`+process timeout+kill+**per-repo no-overlap lock**+min interval+**sleep 후 catch-up storm 억제**, human-needed면 자동 정지. 이걸 어기면(숨은 데몬/무한 poll/비가시 background runner/governance 내부 루프) #5 위반.
- **상태는 app SQLite**(boule.config 아님 — config=거버넌스 포스처/git-adjacent, ticker=설치별 운영. git-adjacent에 넣으면 팀 전체 자동화 사고).

## 2. INVARIANT 준수 (decision-rails — 리뷰 바)

| #                       | posture                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 자동화→결정레일 금지  | **토글은 구조적으로 못 한다**: autonomyLevel 변경·`accept_spec`/`accept_plan`·`decision_blocked` 해소·stall 복구·거버넌스 이벤트 직접 쓰기·승인 위조. Tauri는 오직 설정 영속 + bounded `boule tick` spawn + TickReport 영속. tick 자체는 기존 autonomyLevel/halt/stall 게이트 그대로. |
| 2 외부 토큰 keychain    | ticker는 토큰 미취급(설정+spawn만).                                                                                                                                                                                                                                                   |
| 3 외부 네트워크 Rust    | 해당 없음(로컬 spawn).                                                                                                                                                                                                                                                                |
| 4 IPC=specta            | 신규 IPC 커맨드/타입 전부 tauri-specta 생성, bindings drift CI 0.                                                                                                                                                                                                                     |
| 5 bounded retry         | 앱 스케줄러=bounded(min interval·no overlap·no catch-up·앱-bound). 각 tick=`--max-steps`+timeout+kill. 데몬/무한poll 없음.                                                                                                                                                            |
| 6 SQLite 마이그레이션만 | **app DB** 신규 마이그레이션 `0045_project_ticker.sql`(governance event-sourced와 무관 — app SQLite는 마이그레이션이 정본). 임의 ALTER 금지.                                                                                                                                          |
| 7 시각 디자인           | Control Room row = shadcn/lucide/Tailwind v4 토큰, DESIGN.md 준수.                                                                                                                                                                                                                    |

**fail-closed 포스처(codex D):** tick 결과가 `halted_decision`/`stalled`/`needs_human`(exit 10) → 그 프로젝트 `attention_required=true` 마크 + Control Room "waiting on you" + **그 repo 자동 tick 억제(사람 액션/수동 재개까지)**. exit 10을 성공으로 취급 금지. 알려진 decision/stall에 tick 반복 발사 금지(로그 스팸·무의미 churn·약한 fail-closed).

## 3. 데이터 모델 — app SQLite `project_ticker` (마이그레이션 0045)

| 컬럼                                      | 의미                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `project_id` (PK/FK)                      | 프로젝트                                                                                          |
| `tick_enabled` (bool, default false)      | 박동 on/off                                                                                       |
| `interval_sec` (int, nullable)            | 자동 박동 주기(null=수동만). min-clamp.                                                           |
| `max_steps` (int, default 1)              | tick당 blast-radius 캡                                                                            |
| `next_due_at` (ts, nullable)              | 다음 자동 tick 예정                                                                               |
| `in_progress` (bool)                      | no-overlap lock(실행 중)                                                                          |
| `last_started_at`/`last_finished_at` (ts) | 마지막 실행 시각                                                                                  |
| `last_outcome` (text)                     | TickReport.outcome(advanced/idle/in_flight/halted_decision/stalled/readiness_failed/infra_failed) |
| `last_exit_code` (int)                    | 0/10/1                                                                                            |
| `last_report_json` (text)                 | 전체 TickReport(진단·표시용)                                                                      |
| `attention_required` (bool)               | halt/stall/needs_human → true, 사람 재개까지 자동 억제                                            |

## 4. 페이즈 (T1 → T5)

각 슬라이스 공통: TDD → app 게이트(`cargo test`[bindings 재생성]+`clippy -D warnings`+`fmt --check`+`pnpm typecheck`+`pnpm lint`+bindings drift 0) → **별도 opus critic ACCEPT** → 커밋 → dev 머지+푸시. codex --yolo 가시 pane. INVARIANT #6: 새 마이그레이션은 0045 한 개(불변·sqlx checksum).

### Phase T1 — Ticker runtime + 수동 "Tick now" ⭐ 최소 "켜면 실제로 돈다"

**Goal**: 박동을 프로그램적으로 돌릴 수 있는 최소 기반. interval 없이 **수동 tick**만 — 가장 작은 닫힌 루프.
**Deliverables**:

- 마이그레이션 `0045_project_ticker.sql`.
- Rust **Ticker Runner**: DB에서 repo `local_path` 해소(렌더러 입력 금지) → `boule tick --repo <path> --max-steps N --json`을 **bounded spawn**(`agent.rs` JobManager의 timeout/kill 패턴 재사용) + **per-repo no-overlap lock**(`in_progress`) → `TickReport` 파싱 → SQLite 영속. exit 10/1 정확 분류, `attention_required` 세팅.
- IPC(tauri-specta): `get_project_tick_status(project_id)`, `set_project_tick_enabled(project_id,bool)`, `set_project_tick_interval(project_id,sec?)`, `tick_project_now(project_id)`.
- ⚠ 릴리즈 빌드에서 `boule` 실제 위치/실행 가능 확인(node+entrypoint 해소; GUI 앱 PATH ≠ 셸 — `agent.rs` codex 바이너리 탐색 패턴 참고).
  **Done**: `tick_project_now` 호출 → 실제 `boule tick` 1회 bounded 실행 → TickReport SQLite 영속 + (관측). overlap lock으로 중복 실행 0. exit 10 → attention_required.
  **Tests**: runner가 DB-해소 path로 spawn(렌더러 path 거부) · no-overlap(in_progress 중 재호출 거부/스킵) · exit 10 → attention_required + 성공 아님 · timeout → kill · 토글이 autonomyLevel/거버넌스 이벤트 미변경(구조적).

### Phase T2 — 앱 바운드 bounded 스케줄러

**Goal**: `interval_sec` 설정 시 앱이 due row를 박동(자동). 데몬 아님(앱-bound).
**Deliverables**: bounded interval 태스크가 `next_due_at` 지난 enabled row를 tick(min interval clamp·**catch-up storm 억제**[sleep/resume 후 밀린 것 1회만]·no-overlap·`--max-steps` 캡). 앱 종료=정지(명시 UI). `attention_required` row는 자동 억제(수동 재개까지).
**Done**: interval 설정 프로젝트가 사람 개입 0으로 박동(dispatch 레벨 이상일 때 전진). halt/stall → 자동 억제 관측. negative: 무한 루프/overlap/catch-up storm 부재.

### Phase T3 — Control Room ticker row (UI)

**Goal**: 프로젝트별 토글·interval·"Tick now"·last outcome·next tick·attention을 Control Room에.
**Deliverables**: **별도 ticker/status 쿼리**(죽은 `snapshot.rs` global projection 재사용 금지 — codex C 하드라인) → per-project ticker 카드/row. autonomyLevel과 함께 표기("Clock on, autonomy manual — waiting for human gates"). attention_required = 눈에 띄는 "waiting on you". shadcn/lucide/토큰.
**Done**: GUI에서 프로젝트별 ticker on/off + 수동 tick + 상태 확인(라이브 = 사용자/cmux 스모크). bindings drift 0.

### Phase T4 (P1) — Control Room 라이브 데이터 재배선

**Goal**: schematic/tasks/plans/sessions를 per-repo `.boule/workspace` 이벤트 fold로 실라이브화(현재 `snapshot.rs`는 죽은 global projection).
**Deliverables**: `snapshot.rs`를 per-project `.boule/workspace` 이벤트 reader로 교체(또는 governance가 state/\*.json 투영 write-path 배선). 더 큰 작업 → 분리.
**Done**: Control Room이 실제 거버넌스 상태를 per-project로 표시.

### Phase T5 (deferred) — OS 스케줄러

**Goal**: 앱 닫혀도 박동(launchd/cron/Task Scheduler). cross-platform·권한·uninstall cleanup·패키징 → scope 폭발이라 **연기**(codex A). 단일 플랫폼만 만들고 "일반 지원"인 척 금지.

## 5. 의존 그래프

```
T1 (runtime + manual tick) ⭐
 ├─ T2 (app-bound scheduler)
 └─ T3 (Control Room row)   ← T1 IPC 위
      └─ T4 (live-data rewire, P1)
           └─ T5 (OS scheduler, deferred)
```

T1이 단일 임계 기반. T2(스케줄러)·T3(UI)는 T1 후 병렬 가능(다른 표면). T4는 더 큰 별도. T5 연기.

## 6. 절대 반쯤 출시 금지 (codex F)

- 무한(unbounded) 타이머 · overlap tick · sleep 후 catch-up tick 폭주 · 숨은 autonomy 에스컬레이션(토글이 autonomyLevel 변경) · 렌더러-공급 repo path · exit 10을 성공으로 삼킴 · `decision_blocked`/stall 지속 중 자동 실행 · 릴리즈 빌드가 `boule`를 못 찾음 · OS 스케줄러를 한 플랫폼만 만들고 일반 지원인 척.

## 7. 검증 (정본 = docs/reference/commands.md)

- app: `cargo test`(+bindings 재생성) + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check` / `pnpm typecheck`+`pnpm lint`+`pnpm vitest run` / **bindings drift 0**(specta+CI) / `pnpm tauri dev` 부팅.
- 라이브 박동/스모크 = 관측 증거("could not run" ≠ "passed"), cmux/사용자.

## 8. codex 2-brain consult — provenance (요점)

clean CODEX_HOME read-only consult, gpt-5.5. A=앱-bound interval은 조건부 #5 OK(엔진에 cadence 금지)·시작은 수동 tick+interval·OS스케줄러 연기. B=app SQLite(boule.config 아님)·Ticker⊥autonomyLevel·"auto mode" 네이밍 금지. C=풀 라이브 재배선은 비-선행조건이나 죽은 projection으로 라이브 위조 금지(별도 status 쿼리). D=토글 구조적 금지 목록·halt/stall→attention+자동억제. E=별도 새 플랜. F=최소 슬라이스(SQLite+IPC4+bounded runner+no-overlap+스케줄러+Control Room row)·반쯤 출시 금지 목록.
