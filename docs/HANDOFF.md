# Work Radar — 세션 핸드오프 (현재: Phase 2 시작 직전)

> 새 세션은 **이 파일 + 아래 정본들**을 먼저 읽고 시작한다. 이전 대화 컨텍스트 없이도 진행 가능하도록 작성됨.

## 지금 상태

- **Phase 0(스켈레톤) + Phase 1(Capture Board) 완료·검증·커밋·푸시됨.** 레포 `64etuor/work-radar`(Private), dev 푸시, **CI 그린**.
  - Phase 1 커밋: `6fecaff feat(capture-board): Phase 1 — 5-region 캡처 보드`.
- **Phase 1 산출물(코드 구현됨):**
  - **스키마 v2**(`migrations/0002_capture_board.sql`): `signals`에 `kind`(개인/업무)·`area`/`suggested_area`(Phase 9용 데이터 필드)·`today_for_date`/`today_done_at`/`today_rank`(Today 멤버십) 추가. `routines` + `routine_checks`(날짜별 완료) 신규.
  - **IPC 커맨드 16개**(`src-tauri/src/commands.rs`, specta 생성 `src/bindings.ts`): create/list/classify signal, set_status/snooze, promote/unpromote/toggle_done/reorder today, list_today, create_promotion_draft, search_signals(FTS), create/list_today routines, toggle_routine_check.
  - **프런트**(`src/components/CaptureBoard.tsx` + `src/components/board/*` + `.cb` CSS in `src/styles.css`): 5영역 보드, 촤라락/톡, 드래그+`1/2/3/4` 분류, Today 레일(+N 경과일·rollover·되돌리기·재정렬), Routines, 카드 메뉴(백로그/안건/캘린더=draft만, Today/snooze/done/archive), 반응형 3단계. 데이터는 `src/lib/query.ts` 훅(TanStack Query).
  - INVARIANTS 준수 reviewer(architect) **APPROVED**: #1 카드 항상 unclassified 진입(자동분류 0), #2 외부승격=draft only(외부 무변경), #3 dedup upsert, #7 SQLite SSOT.
- **다음 = Phase 2 (Project & 멀티 레포 설정)** — `dev` 브랜치에서.

### Phase 1 미해결/관찰 항목 (Phase 2에서 고려)

- **GUI 관찰 미실시(헤드리스 한계):** 실제 창 렌더·핫키 show/hide·드래그 감각·재시작 영속은 사용자가 `pnpm tauri dev`로 확인 필요. (cargo는 `export PATH="$HOME/.cargo/bin:$PATH"` 후 실행.)
- **FTS UI 없음:** `search_signals` 커맨드+단위테스트만 존재(보드에 검색 박스 없음 — 프로토타입에 없어서 보류). cmdk 전역 검색 통합 시 노출 예정.
- **`RootPalette.tsx` 미사용 보존:** Phase 0 cmdk 루트 팔레트. 보드로 교체됐으나 추후 전역 검색/네비게이션에 재사용 여지. **Phase 2 네비게이션(설정/프로젝트 뷰 진입)을 어떻게 둘지 결정 필요** — 현재 앱 = 보드 전체 화면이라 "Add Project"로 갈 경로가 없음.
- **signals.kind ↔ projectId reconcile:** Phase 1 신호는 `kind`(personal/work) 힌트만 보유, `project_id`는 NULL(프로젝트 없음). Phase 2에서 프로젝트 생성 후 reconcile 경로 설계.

## 먼저 읽을 정본

1. `PLAN.md` — §1 INVARIANTS(절대규칙 7개) + **Phase 2** Deliverables/Done-criteria
2. `docs/architecture.md` — §3 멀티 프로젝트/레포(Project/Repo 모델), §4 데이터 모델, §6 SSOT
3. `DESIGN.md` — 토큰/컴포넌트 정본(Cohere white editorial). 설정/폼 표면은 `contact-form-card`·`button-primary`·토큰 사용
4. `docs/decisions.md` — Phase 0/1 결정(특히 keychain 3.x, 단일 창 모델, Today 멤버십 설계)
5. `AGENTS.md` — working agreement, `docs/reference/commands.md` — 검증 명령 인덱스

## Phase 2 스코프 (한 번에 한 Phase, PLAN.md Phase 2 done-criteria만)

PLAN.md Phase 2 핵심:
- **Add Project**(`personal`/`work`) / **Add Repo**(github remote · local path). `projects`/`repos` 테이블은 0001에 이미 존재.
- **project별 토큰 keychain 저장**(평문 DB/프런트 금지 — INVARIANT). **keychain 모듈은 Phase 0에 계약/모듈만 존재**(`src-tauri/src/keychain.rs`, `#[allow(dead_code)]`) → **여기서 호출부 연결**.
- **Notion DB(backlog/agenda) 바인딩** + `ticketKeyPattern`(예: `MIR-DEV-\d+`) 설정.
- **모든 signal/run에 projectId 태깅** — Phase 1 `kind` 힌트를 reconcile.

**Done-criteria:**
- [ ] 개인 1 + 업무 1 프로젝트 생성, repo 목록 표시
- [ ] 토큰이 keychain에 저장됨(평문 DB 아님), 재부팅 후 유지
- [ ] 각 project 토큰으로 테스트 API ping 성공/실패 표시 (Notion/GitHub 호출은 **Rust**에, reqwest/octocrab — Cargo.toml에 아직 없음 → 추가 필요)
- [ ] 모든 signal/run이 `projectId` 태깅

**설계 선결 과제(시작 전 결정):**
- 보드 ↔ 설정/프로젝트 뷰 **네비게이션**(예: 헤더 버튼/cmdk/단축키로 Settings 뷰 토글). 단일 창 유지.
- 토큰 입력 UI는 **렌더러에 토큰 평문을 들고 있지 않도록** 즉시 keychain 커맨드로 넘긴다(IPC 인자로만 전달, 상태 저장 금지).

## 운영 노트 (환경 함정)

- **Rust 툴체인:** cargo는 `$HOME/.cargo/bin`에 있으나 **기본 PATH에 없음**. cargo/`git commit`(husky pre-commit가 `cargo fmt --check` 실행) 전 매번 `export PATH="$HOME/.cargo/bin:$PATH"`. cargo 명령은 `src-tauri/`에서. (`--no-verify` 대신 PATH export로 훅을 정상 통과시킬 것.)
- **rtk 훅 주의:** `cargo` 출력 요약/exit code를 신뢰하지 말 것(예: clippy "1 errors" 오탐). 진짜 결과는 `rtk proxy cargo …`로 raw 확인, 또는 출력 파일을 **Read 도구**로 읽기. 백그라운드 exit code도 못 믿음 → 실제 출력 확인.
- **bindings.ts:** `cargo test`의 export 테스트가 생성(프런트 빌드 전 필요). 수기 IPC 타입 금지(specta). **specta는 i64 export 금지** → 작은 정수는 `i32`.
- **GUI 검증:** 실제 창/핫키/keychain 영속은 **사용자 관찰 항목**. 헤드리스에선 `cargo build/test/clippy` + `pnpm build`(tsc) + 필요시 `pnpm tauri dev` 부팅 로그.
- **테스트 임시 DB:** 병렬+coarse 클록 충돌 방지로 `temp_db_path`에 원자 카운터 사용(이미 적용). 새 DB 테스트도 동일 패턴.

## Git 워크플로우 (중요)

- **항상 `dev`에서 작업/커밋/push.** `main`은 PR(dev → main)로만 머지. `git push origin main`은 `.husky/pre-push`가 차단.
- 커밋 = Conventional Commits. 이슈 번호는 PR에만(커밋 메시지 금지). 한 PR = 한 관심사.
- gh 활성 계정이 가끔 `yanghapark`로 바뀜 → `gh auth switch --user 64etuor`로 고정.
- 레포: `64etuor/work-radar` (Private). CI(main·dev): rust fmt/clippy/test + frontend typecheck/build. **현재 dev CI 그린.**

## 시작 명령(새 세션에 붙여넣기)

```
/oh-my-claudecode:ralph work-radar Phase 2 (Project & 멀티 레포 설정) 구현.
먼저 docs/HANDOFF.md → PLAN.md(§1 INVARIANTS + Phase 2) → docs/architecture.md(§3 Project/Repo, §6 SSOT)
→ DESIGN.md(폼/설정 토큰) → docs/decisions.md(keychain 3.x) 순으로 읽고 그대로 따른다.
한 번에 한 Phase, PLAN.md Phase 2 done-criteria로 자가검증. INVARIANTS 7개 준수(특히 토큰 keychain·렌더러 노출 금지).
작업/푸시는 dev 브랜치에만(main 직접 push 금지). 시작 전 보드↔설정 네비게이션 방식만 확인하고 바로 진행해.
```
