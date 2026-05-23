# 품질 후속 — 남은 작업 실행 지침 (2026-05-23)

> **이 문서만 읽고도** 다음 세션이 컨텍스트 없이 진행할 수 있도록 작성. 정본 규칙은
> `AGENTS.md`(working agreement) + `PLAN.md §1`(INVARIANTS 7개) + `docs/architecture.md`.
> 명령은 `docs/reference/commands.md`. 이 문서는 *남은 리팩터링 항목 + 실행 프로토콜*만 담는다.

## 0. 배경 (이미 끝난 것)

2026-05-22 리뷰(아키텍처/코드/문서 3축)의 ROI 우선순위 6건이 이미 dev에 머지됨 — 상세는
`docs/decisions.md` "품질 후속 (cross-cutting, 2026-05-22)" 한 곳에 기록:
WAL+busy_timeout, 도메인 에러 thiserror, `with_retry` 통합+`Retryable`, `require_awaiting()`
추출, 프런트 Vitest, `agents.rs`/`today.rs` 서브모듈 분리, 문서 정합성.
**아래는 그때 "다음 epoch/백로그"로 미룬 나머지다.**

---

## 0.5 진행 상황 (2026-05-23 재검증 — dev 239 tests green, clippy 0)

후속 세션들이 §2의 **자율-안전 항목(A·B·C·H)과 소형 백로그(I·J)를 이미 완료**했다. 코드 재검증 결과:

- **A · NOTION_VERSION** ✅ — `notion.rs:22` 단일 `pub(crate) const NOTION_VERSION`, `api.rs:8`/`commands/notion.rs:484`가 참조(하드코딩 리터럴 0). (플랜의 api.rs:9 / commands/notion.rs:440 라인은 stale.)
- **B · shortcut 빈입력 가드** ✅ — `shortcut.rs:26` `split_last()` → match `Err` 폴백(비-test unwrap 없음), `shortcut::tests::rejects_empty_or_blank_without_panic` green.
- **C · routines 분리** ✅ — `commands/routines/`(mod.rs + crud/listing/reminders/schedule/tracking), `bindings.ts` 동일.
- **H · sync_pr_radar 타입에러** ✅ 해소(B-시리즈) — `sync_pr_radar`가 `AppError` 반환 + `e.is_retryable()`→`AppError::transient/terminal` 분류 보존. `pr_radar::tests::all_repos_{transient,terminal}_failure_*` green. 분류 손실 없음.
- **I · 로그 스크럽(보안)** ✅ — `classify_http`(calendar.rs/messenger.rs)가 본문 대신 크기만 노출(`HTTP {status} (응답 {len}B)`, 스펙 §5.5). `classify_http_buckets` 테스트가 `!contains("SECRET_BODY_xyz")` 검증.
- **J · toast retryable 배선(UX)** ✅ — `query/client.ts` 전역 `onError`가 retryable 시 `onRetry: () => query.fetch()` 주입 → `toast.ts`/`ToastHost.tsx` "재시도" 버튼(decisions.md "품질 후속" 참조).
- **E · 내부 JSON 타이핑** ✅ — 잡 `trigger`(`EnrichTrigger`/`BatchEnrichTrigger`/`PrJobTrigger`)·신호 `links`(`PrSignalLinks`)가 serde 구조체로 타입화(camelCase 키 보존, critic ACCEPT). DB 컬럼은 직렬화된 JSON이라 경계의 `Option<String>`은 정상(외부 codex `proposal`은 의도적으로 문자열 유지).
- **D · 잡 상태 enum 단일화** ✅ — `AgentRunStatus.status: String`과 흩어진 SQL 리터럴을 닫힌 enum으로 통일. **신규 `JobStatus`를 만들지 않고 기존 `AgentStatus`를 재사용**(이미 6변종+sqlx::Type/specta/serde, `AgentRunView` 사용 — 병렬 enum은 드리프트 신설이라 DRY가 옳음). `AgentStatus::as_str()`+`Display`를 문자열 단일 출처로 추가, 모델 경계·`require_awaiting`·`run_status_trigger`·`finalize`·Acceptance 게이트 UPDATE까지 enum 바인딩으로 경유. 스키마 무변경(TEXT+CHECK 유지). bindings.ts `AgentRunStatus.status`는 의도적으로 `string`→`AgentStatus` union으로 좁아짐. critic ACCEPT(INVARIANT #1/#2/#5 보존), SSOT 잠금 테스트 2개 추가(test 241 green). decisions.md "품질 후속" 기록.

> 위 8건(A·B·C·D·E·H·I·J)은 `docs/decisions.md` "품질 후속 (cross-cutting, 2026-05-22)"에 커밋 단위로 기록돼 있음.

**남은 진짜 작업(전부 게이트 필요 — 자율 착수 금지):**
- **F · repository 레이어**(대형, 진행 중) — `signal_store`(signals 슬라이스, `dd586b7`) + `agent_run_store`(agent_runs 슬라이스, 2026-05-23) **done**. 설계/구현 정본: `docs/plans/2026-05-23-agent-run-store-{design,impl}.md`. **남은 store(별도 PR, 한 PR=한 store, 큰 것부터)**: `routine_store`(~31) → `promotion_store`(notion ~21) → `skill_store`(~20) → `pr_radar_store`(~11, `pr_self_checks` 합류) → 소형(projects/hermes/calendar/retro/nav). today 레일은 signals 직접 읽어 G와 강결합 → G와 함께.
- **G · signals god-table 분리**(대형·스키마·가장 위험). `signal_store`만 의존하므로 F 잔여와 독립 착수 가능. **brainstorming + Phase 승격 + 마이그레이션(임의 ALTER 금지) + 데이터 보존 테스트 + critic** 선행.

> 자율-안전 배치 + D(critic) + F의 signals·agent_runs 슬라이스까지 소진됨. 다음 착수는 **F 잔여 store(routine_store 권장)** 또는 **G(brainstorming)** — 사람 확인 후.

---

## 1. 실행 프로토콜 (모든 항목 공통 — 반드시 지킬 것)

### 1.1 브랜치/머지 (dev 오염 금지)
- **항목 1개 = feature 브랜치 1개.** `git checkout -b <type>/<slug>` (예: `refactor/split-routines`).
- 순서: 구현 → **검증(아래 1.3)** → `dev`로 `--ff-only` 머지 → `git push origin dev` → 브랜치 삭제.
- `dev`는 **항상 green만 수령.** 검증 실패 상태를 dev에 올리지 않는다.
- `main` 직접 push 금지(husky pre-push가 차단). 작업·push는 `dev`.
- **병렬 worktree 에이전트 금지** — 서로/`dev` 오염 전례 있음. 위임은 **단일·순차 executor**, 결과는 오케스트레이터가 독립 재검증.

### 1.2 환경 함정 (실측 기반)
- **cargo가 기본 PATH에 없음.** cargo/커밋 전 항상 `export PATH="$HOME/.cargo/bin:$PATH"`
  (husky pre-commit이 `cargo fmt --check` 실행).
- **rtk 래핑 cargo/grep은 출력이 부정확**(가짜 "N errors", 존재 심볼을 "없음"으로). 검증은
  `rtk proxy cargo ...`로, 파일 확인은 **Read 도구**로 교차검증. 파이프(`| tail` 등)는 파일
  리다이렉트 후 Read.
- husky pre-commit = `cargo fmt --check` + `pnpm typecheck`. **커밋 전 `cargo fmt` 한 번** 돌려
  import 줄바꿈 등 fmt 차이로 막히는 것 방지.
- **위임 후 늦은 쓰기 주의**: executor가 완료 보고 *후*에도 트리에 파일을 flush할 수 있다.
  커밋 직전 + 다음 브랜치 만들기 직전 `git status --short` + `git diff --stat`로 실제 트리 확인.

### 1.3 검증 (체크박스 = 실행 증거, prose 우회 금지)
- Rust: `rtk proxy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` (0)
  + `rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4` (현재 **200 passed/0 failed** 기준, 신규 테스트만큼 증가).
- 프런트: `pnpm test` + `pnpm typecheck` + `pnpm build`.
- **순수 리팩터(모듈 분리 등)의 행위 보존 증명**: `cargo test`가 `src/bindings.ts`를 재생성하므로
  `git diff --exit-code src/bindings.ts`가 **비어야 함**(IPC 표면 동일). 비지 않으면 `pub`/시그니처가 바뀐 것.
- **결정 레일/Acceptance 게이트를 건드리는 변경은 self-approve 금지** → `critic` 또는
  `code-reviewer` 별도 패스로 INVARIANT #1/#2/#5 보존 확인 후 머지.
- 각 항목 머지 시 `docs/decisions.md`에 한 줄 + 트레이드오프 기록.

---

## 2. 남은 항목 (ROI·위험 순)

### A. NOTION_VERSION 단일화 + 하드코딩 제거  [tiny, safe]
- **무엇:** `NOTION_VERSION = "2022-06-28"`이 `notion.rs:21`(priv)·`api.rs:9`(dup) 두 곳에 중복,
  `commands/notion.rs:440`은 리터럴 하드코딩.
- **접근:** 단일 `pub const NOTION_VERSION`(예: `api.rs` 또는 새 `constants` 모듈)로 통일하고
  세 곳이 그것을 참조. 가장 작은 변경.
- **Done:** 리터럴 0, 상수 정의 1개. clippy 0 + test 그대로.

### B. shortcut 파서 빈 입력 가드  [tiny, safe]
- **무엇:** `shortcut.rs:28` `split_last().unwrap()` — 빈 hotkey 스펙 문자열에서 panic 가능(리뷰 견해
  갈림). 입력은 config에서 옴.
- **접근:** `parse_shortcut`이 빈/형식오류 입력에 panic 대신 `DEFAULT_GLOBAL_HOTKEY`(`shortcut.rs:11`)로
  graceful fallback. 빈 문자열 케이스 단위테스트 추가.
- **Done:** 빈/공백 입력 테스트 green, 비-test unwrap 제거.

### C. `routines.rs` 서브모듈 분리  [medium, 저위험 — 검증된 패턴]
- **무엇:** `commands/routines.rs` 1208 LOC, 7 커맨드 — `agents`/`today`와 같은 저응집.
- **접근:** `today/`·`agents/` 분리와 **동일 패턴**: `commands/routines/` 디렉터리(`mod.rs` +
  도메인별 서브모듈), `mod.rs`가 `pub use <sub>::*`로 전 공개항목 재export → `commands::*`·
  `bindings.ts` 무변경. 공유 헬퍼는 `mod.rs`(submodule이 `super::`로 접근). 섹션 주석(`// ──`)으로
  경계 파악. 순수 move(로직/시그니처/이름 무변경).
- **위험:** 낮음(검증된 절차). executor 위임 가능.
- **Done:** `git diff src/bindings.ts` 비어 있음 + clippy 0 + test 동일 카운트.

### D. `JobStatus` enum (primitive obsession)  [medium]
- **무엇:** `models.rs:145` agent run `status: String`. 형제 enum 패턴 있음
  (`TokenKind` `models.rs:90`, `SignalStatus` `:223`, `PromotionStatus` `:297`, `CiStatus` `:550`).
- **접근:** `JobStatus` enum(`proposed`/`running`/`awaiting_approval`/`succeeded`/`failed`/`cancelled`)
  + `as_str()`/parse. **주의:** SQL 문자열 리터럴(`'awaiting_approval'` 등)이 `jobs.rs`·`agents/*`에
  흩어져 있음 — enum 도입해도 SQL 바인딩 문자열은 `as_str()` 경유로 단일화. Acceptance 게이트
  문자열을 건드리므로 **critic 패스 필수**(INVARIANT #2). bindings는 바뀔 수 있음(타입 노출 시) —
  의도된 변경이면 OK(단, 프런트 소비처 확인).
- **Done:** 상태 문자열 단일 출처, test+critic green.

### E. 내부 stringly-typed JSON → serde 구조체  [medium]
- **무엇:** 앱이 전적으로 통제하는 내부 페이로드가 문자열 JSON으로 오감 — `jobs.rs` `trigger`,
  signals `links`(`pr_radar.rs`). (Codex가 내는 `proposal`은 외부라 문자열 유지가 맞음 — 건드리지 말 것.)
- **접근:** `trigger`/`links`만 `serde` 구조체로 정의하고 경계에서 직렬화. 외부 비결정 페이로드는 제외.
- **Done:** 내부 페이로드 타입화, 동작 동일, test green.

### F. `commands/` 데이터 접근(repository) 레이어  [large, 다음 epoch]
- **무엇:** SQL이 IPC 핸들러에 집중(agents/today/routines/notion 등 다수 `sqlx::query`). 도메인 모듈은
  네트워크/프로세스 로직만 보유 → 영속 로직이 명령 레이어에 누수, 대형 파일·SQL 경로 테스트 곤란.
- **접근:** aggregate별 `*_store.rs`(plain `async fn`로 sqlx 캡슐화)를 만들고 커맨드가 호출. **가장 큰
  것부터**(signals, agent_runs — 후자는 `jobs.rs`가 부분적으로 그 역할). 점진 적용(한 PR=한 store).
- **위험:** 큼(광범위). 반드시 단계 분할 + 각 단계 bindings/test 보존.
- **선행:** brainstorming으로 store 경계 합의 후 착수(`PLAN.md` 신규 Phase로 승격 검토).

### G. `signals` god-table 분리  [large, 가장 위험 — 스키마]
- **무엇:** `signals` 단일 테이블이 매트릭스 카드 + Today 레일 멤버십(`today_for_date`/`today_done_at`/
  `today_rank`, `migrations/0002`) + 회고 태그(`impact_high`/`regret`, `migrations/0010`) + area 등 5+
  관심사를 한 행에 결합 → 무관 라이프사이클 커플링, 다수 명령이 직접 write.
- **접근:** Today 레일 멤버십·회고 태그를 `signal_id` 키 **위성 테이블**로 분리하는 **마이그레이션**
  (임의 ALTER 금지 — `migrations/`의 새 버전 파일로만, INVARIANT). 쿼리/집계(`today/`, `retro`,
  `weekly`) 재작성 + dedup/auto-resolve(INVARIANT #3) 보존.
- **위험:** 가장 큼(데이터 이동 + 다수 쿼리). 마이그레이션 데이터 보존 테스트(예: `db.rs`의 0011
  보존 테스트 선례) 필수 + critic.
- **선행:** brainstorming + `docs/decisions.md`에 결정 기록 후 착수. **F(repository) 다음에** 하면
  쿼리가 store에 모여 있어 변경 표면이 작아짐.

### H~J. 에러-처리 백로그 (먼저 *현재 상태 검증* 후 진행)
> `docs/decisions.md` Phase 9~B4 + 에러 마이그레이션 기록의 비차단 백로그. **B-시리즈 개편으로
> 이미 해소됐을 수 있으니 손대기 전 코드 확인.**
- **H. `sync_pr_radar` 타입 에러:** `commands/pr_radar.rs:218`. 현재 주석상 `GithubError`가
  Retryable 자기분류(`:228`)하고 `errors.join`(`:286`)으로 메시지 합침 — **분류 손실이 남아있는지
  먼저 확인.** 남아있으면 레포별 typed 에러 보존.
- **I. 로그 스크럽(보안):** 외부 응답 본문 snippet(≤300자, `classify_http` — calendar/messenger)이
  `errors.log`에 흘러들 수 있음. logged message에서 본문 스크럽(스펙 §5.5).
- **J. toast retryable 재시도 배선(UX):** `toast.ts`의 `retryable`은 현재 표시만 — 실제 refetch 미배선.

---

## 3. 권장 순서
1. **A, B** (tiny·safe, 한 PR로 묶어도 무방하나 관심사 분리 권장) — 빠른 청소.
2. **C** (routines 분리 — 검증된 패턴, executor 위임).
3. **H 검증** → 필요 시 H/I/J (에러 백로그, 작음).
4. **D, E** (타이핑 강화, critic 필요).
5. **F → G** (대형, 반드시 brainstorming + Phase 승격 + 단계 분할; G는 F 이후).

> 1~3은 자율 진행 가능. **4의 D(게이트 문자열)·5(F/G)는 사람 확인/brainstorming 후 착수** —
> 결정 레일/스키마/IPC 표면에 영향이 크므로 self-approve 금지.
