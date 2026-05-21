# Work Radar — 세션 핸드오프 (현재: Phase 3 시작 직전)

> 새 세션은 **이 파일 + 아래 정본들**을 먼저 읽고 시작한다. 이전 대화 컨텍스트 없이도 진행 가능하도록 작성됨.

## 지금 상태

- **Phase 0(스켈레톤) + Phase 1(Capture Board) + Phase 2(Project & 멀티 레포 설정) 완료·검증·커밋·푸시됨.** 레포 `64etuor/work-radar`(Private), dev 푸시.
  - Phase 1 커밋: `6fecaff feat(capture-board): Phase 1 — 5-region 캡처 보드`.
  - Phase 2 커밋: `d57f300 feat(settings): Phase 2 — Project/Repo 설정 + project별 토큰 keychain + Notion/GitHub ping`.
- **Phase 2 산출물(코드 구현됨):**
  - **신규 마이그레이션 없음** — `projects`/`repos` 테이블과 `signals.project_id`는 0001에 이미 존재 → 호출부(커맨드/UI)만 연결.
  - **백엔드:** `src-tauri/src/keychain.rs`(Phase 0 `#[allow(dead_code)]` → 호출부 연결; `TokenKind`(Notion/GitHub)별 set/get/has/delete, account=`{credential_ref}:{kind}`), `src-tauri/src/api.rs`(신규: `ping_notion`=reqwest GET `/v1/users/me`, `ping_github`=octocrab `current().user()`; read-only·단일 시도·timeout), 커맨드 9종(`create_project`, `list_repos`, `create_repo`, `set/delete/status/ping_project_token`, `reconcile_signal_projects`, `set_signal_project`) + `create_signal`에 `projectId`. `Cargo.toml`에 reqwest+octocrab(rustls-tls 통일).
  - **프런트:** cmdk 팔레트 네비게이션(`src/components/CommandPalette.tsx`, `⌘K`/`⌘,`) + `src/components/SettingsView.tsx` + `src/components/settings/*`(AddProjectForm·ProjectCard·TokenRow·AddRepoForm) + `.settings`/`.cmdk` CSS. 토큰은 로컬 state에만 잠시 두고 저장 즉시 비움(렌더러/캐시 미보관). store에 view/palette 상태.
  - INVARIANTS reviewer(architect, opus) **APPROVED**: 7개 PASS — 토큰 keychain 전용·렌더러 미노출(end-to-end), ping read-only·bounded, projectId는 메타데이터(quadrant/승격 불변).
- **다음 = Phase 3 (Notion 승격 write 레일)** — `dev` 브랜치에서.

### Phase 2 미해결/관찰 항목 (Phase 3에서 고려)

- **GUI/keychain/network 관찰 미실시(헤드리스 한계):** 실제 창·`⌘K` 팔레트 렌더, **토큰 keychain 저장·재부팅 영속**, **실 Notion/GitHub ping 성공/실패**는 사용자가 `pnpm tauri dev`로 확인. (cargo는 `export PATH="$HOME/.cargo/bin:$PATH"` 후.)
- **Acceptance 게이트 흐름 미정(Phase 3 선결):** Phase 2는 `create_promotion_draft`로 **draft만** 만든다(외부 무변경). Phase 3는 draft를 실제 Notion write로 잇는데, **즉시 write vs draft→accept(확인)→write 2단계** 중 택해야 함. 권장 = **2단계**(architecture Acceptance 모델 일치, undo 안전).
- **reconcile 휴리스틱:** `reconcile_signal_projects`는 미태깅·kind 보유 신호를 같은 kind의 **가장 오래된 프로젝트**로 태깅(audit 로그 없음). 1개인+1업무 표준 셋업엔 충분, 멀티 프로젝트/kind면 Phase 3+에서 surfacing 고려.
- **agent_runs.projectId 태깅:** 스키마(0001)에 `project_id` 보유. 잡 도입(Phase 7+) 시 태깅됨 — Phase 2엔 잡이 없어 대상 없음.
- **credential_ref:** project 생성 시 백엔드가 만드는 opaque 키(`lower(hex(randomblob(16)))`, project.id와 별개). keychain account=`{credential_ref}:{kind}`.

## 먼저 읽을 정본

1. `PLAN.md` — §1 INVARIANTS(절대규칙 7개) + **Phase 3** Deliverables/Done-criteria
2. `docs/architecture.md` — §2 3-Rail(Acceptance), §4 Promotion 모델, §6 SSOT & Sync(rate limit 3 req/s·오프라인 큐잉), §7 dedup/auto-resolve
3. `docs/decisions.md` — Phase 2 결정(토큰 keychain·credential_ref·ping·reconcile)
4. `.claude/skills/octocrab-keyring`(Notion=reqwest REST·rate-limit·bounded retry) · `.claude/skills/sqlx-sqlite`(promotions append-only·dedup upsert) · `.claude/skills/tauri-specta-ipc`
5. `DESIGN.md` — 토큰/컴포넌트 정본(Cohere). `AGENTS.md` — working agreement, `docs/reference/commands.md` — 검증 명령 인덱스

## Phase 3 스코프 (한 번에 한 Phase, PLAN.md Phase 3 done-criteria만)

PLAN.md Phase 3 핵심:
- **Notion read(미러 캐시) + 카드→백로그/안건 write-through** + `Promotion` append-only 로그(undo/audit).
- **rate-limit(3 req/s) 인지 클라이언트** + **bounded retry/backoff/jitter** + terminal failure 노출(무한 retry 금지 — INVARIANT #5).
- 토대: Phase 2의 project Notion 토큰(keychain) + `notionBacklogDbId`/`notionAgendaDbId` 바인딩 + `create_promotion_draft`(draft).

**Done-criteria:**
- [ ] 카드 승격 → 해당 project Notion DB에 페이지 생성
- [ ] Promotion 로그에 기록(undo 가능 데이터)
- [ ] 오프라인 시 승격이 큐잉되고 복구 시 flush
- [ ] rate limit 초과해도 무한 retry 없이 backoff 후 실패 노출

**설계 선결 과제(시작 전 결정):**
- **Acceptance 흐름:** draft→accept(확인)→write 2단계 vs 즉시 write (권장 2단계).
- **Notion 페이지 매핑:** 카드 title/body → Notion DB 속성(제목 + 상태/날짜 등) 매핑 규칙. DB 스키마 가정 최소화(제목 속성만 필수, 나머지 선택).
- **오프라인 큐:** `promotions` draft 행을 큐로 재사용할지(status draft→created 전이) 별도 큐 둘지.

## 운영 노트 (환경 함정)

- **Rust 툴체인:** cargo는 `$HOME/.cargo/bin`에 있으나 **기본 PATH에 없음**. cargo/`git commit`(husky pre-commit가 `cargo fmt --check`+`pnpm typecheck` 실행) 전 매번 `export PATH="$HOME/.cargo/bin:$PATH"`. cargo 명령은 `src-tauri/`에서.
- **rtk 훅 주의:** `cargo clippy --all-targets -- -D warnings`는 rtk가 `-- -D warnings`를 망가뜨려(빌드 `-D`를 파일명으로 전달) **가짜 실패** + 요약("1 errors")도 오탐. → `rtk proxy cargo clippy --all-targets -- -D warnings > /tmp/x.log 2>&1; echo EXIT=$?` 후 **Read 도구**로 raw 로그의 `Finished`/`test result: ok` 확인. 백그라운드 exit code도 못 믿음.
- **bindings.ts:** `cargo test`의 export 테스트가 생성(프런트 빌드 전 필요). 수기 IPC 타입 금지(specta). **specta는 i64/u64 export 금지** → 작은 정수는 `i32`/`u32`.
- **GUI 검증:** 실제 창/핫키/keychain 영속/네트워크 ping은 **사용자 관찰 항목**. 헤드리스에선 `cargo build/test/clippy` + `pnpm build`(tsc) + 필요시 `pnpm tauri dev` 부팅 로그.
- **테스트 임시 DB:** 병렬+coarse 클록 충돌 방지로 `temp_db_path`에 원자 카운터(이미 적용). **keychain/실네트워크는 cargo test에 넣지 말 것**(헤드리스 CI 불가) — 사용자 관찰로.

## Git 워크플로우 (중요)

- **항상 `dev`에서 작업/커밋/push.** `main`은 PR(dev → main)로만 머지. `git push origin main`은 `.husky/pre-push`가 차단.
- 커밋 = Conventional Commits. 이슈 번호는 PR에만(커밋 메시지 금지). 한 PR = 한 관심사.
- gh 활성 계정이 가끔 `yanghapark`로 바뀜 → `gh auth switch --user 64etuor`로 고정.
- 레포: `64etuor/work-radar` (Private). CI(main·dev): rust fmt/clippy/test + frontend typecheck/build.

## 시작 명령(새 세션에 붙여넣기)

```
/oh-my-claudecode:ralph work-radar Phase 3 (Notion 승격 write 레일) 구현.
docs/HANDOFF.md → PLAN.md(§1 INVARIANTS + Phase 3) → docs/architecture.md(§6 SSOT, §7 dedup)
→ docs/decisions.md(Phase 2 토큰/credential_ref) 순으로 읽고 따른다. 한 번에 한 Phase,
Phase 3 done-criteria로 자가검증. INVARIANTS 준수(특히 #2 Acceptance 게이트·#3 dedup·
#5 bounded retry/backoff/jitter·#7 SSOT, 토큰 keychain). 작업/푸시는 dev에만.
시작 전 Acceptance 흐름(2단계 vs 즉시)만 확인하고 진행.
```
