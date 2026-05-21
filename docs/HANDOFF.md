# Work Radar — 세션 핸드오프 (현재: Phase 4 시작 직전)

> 새 세션은 **이 파일 + 아래 정본들**을 먼저 읽고 시작한다. 이전 대화 컨텍스트 없이도 진행 가능하도록 작성됨.

## 지금 상태

- **Phase 0(스켈레톤) + Phase 1(Capture Board) + Phase 2(Project & 멀티 레포 설정) + Phase 3(Notion 승격 write 레일) 완료·검증·커밋·푸시됨.** 레포 `64etuor/work-radar`(Private), dev 푸시.
  - Phase 1: `6fecaff`. Phase 2: `d57f300`. Phase 3: 이 세션 커밋(dev).
- **Phase 3 산출물(코드 구현됨):**
  - **신규 마이그레이션 없음** — `promotions`(0001)에 status(draft/confirmed/created/failed)·created_external_id·draft_payload가 이미 존재 → 재사용. 오프라인 큐 = draft 행 재사용.
  - **백엔드:** `src-tauri/src/notion.rs`(신규: rate-limit 인지 reqwest 클라이언트 — `NotionWriter` 트레잇 + `HttpNotionWriter`(retrieve_database로 title 속성명 발견·캐시 → POST /v1/pages), `with_retry`(시도 캡 3 + 지수 backoff + jitter, Terminal 재시도 안 함), `NotionError{Transient,Terminal}`, `RateLimiter`(~3 req/s)). `commands.rs` 신규: `promote_to_notion`(즉시 write — find-or-reuse draft → write → created/draft큐잉/failed, 멱등), `flush_promotions`(복구 시 draft 재시도), `list_promotions`(이력). `execute_promotion` 코어는 `NotionWriter` 제네릭이라 fake writer로 테스트. `models.rs`: `PromotionOutcome`/`FlushSummary`. `Cargo.toml`: tauri-plugin-opener. `lib.rs`: opener 플러그인 + 커맨드 등록. `capabilities/default.json`: `opener:allow-open-url`.
  - **프런트:** `query.ts` `usePromoteToNotion`/`useFlushPromotions`/`openExternal`. `CaptureBoard.tsx` 카드 메뉴 backlog/agenda → 즉시 write, 성공 토스트 + "Notion에서 열기" 링크, 오프라인 큐잉 토스트, `window 'online'`에서 flush. calendar는 기존 draft만(Phase 11). 토스트 CSS(`.cb-toast-link`).
  - INVARIANTS reviewer(architect) **APPROVED** 기록은 이 세션 progress/decisions에. 핵심: #2 사람 클릭=결정/accept(자동화 아님, acceptances 미관여, confirmed 예약), #3 멱등, #5 bounded retry, #7 SSOT·토큰 keychain.
- **다음 = Phase 4 (GitHub PR Radar — read 레일)** — `dev` 브랜치에서.

### Phase 3 미해결/관찰 항목 (Phase 4+에서 고려)

- **실 네트워크 미관찰(헤드리스 한계):** 실제 Notion 페이지 생성·"열기" 딥링크·실제 오프라인 큐잉/복구 flush는 사용자가 `pnpm tauri dev`로 확인(Phase 1/2 GUI 항목과 동일). cargo test는 fake writer + 순수 로직(분류/retry/title 발견)으로 lifecycle만 검증.
- **`confirmed` 상태 미사용:** Phase 9 자동화-draft(예: mismatch 해소 draft)의 2단계 게이트(draft→사람 confirm→write)를 위해 보존. Phase 3 사람-클릭 경로는 즉시 created.
- **signals.links/`linked` 상태:** 성공 시 signals.links에 notionBacklogId/notionAgendaId 머지 + status=linked(매트릭스엔 잔존). 링크 배지 UI는 추후(시각 폴리시).
- **429 Retry-After:** 현재 429는 Transient로 분류해 bounded backoff로 처리(서버 Retry-After 헤더를 정밀 존중하진 않음). 충분히 bounded — 필요 시 Phase 4 GitHub rate limit과 함께 정교화.
- **Notion read 미러 캐시:** Phase 3 deliverable의 "read 미러"는 write 견고화에 필요한 DB 스키마 read(title 속성 발견)로 충족. 백로그/안건 *내용* 풀 미러 캐시는 미구현(필요 시 Phase 6 mismatch에서 도입).

## 먼저 읽을 정본

1. `PLAN.md` — §1 INVARIANTS(절대규칙 7개) + **Phase 4** Deliverables/Done-criteria
2. `docs/architecture.md` — §3 멀티 레포, §4 data model(WorkSignal dedupKey/snapshot), §6 SSOT, §7 dedup/auto-resolve
3. `docs/decisions.md` — Phase 2(토큰 keychain·octocrab rustls) + Phase 3(즉시 write·bounded retry·opener) 결정
4. `.claude/skills/octocrab-keyring`(GitHub=octocrab·페이지네이션·rate-limit·bounded retry) · `.claude/skills/sqlx-sqlite`(dedup upsert·auto-resolve) · `.claude/skills/tauri-specta-ipc`
5. `DESIGN.md` — 토큰/컴포넌트 정본(Cohere). `AGENTS.md` — working agreement, `docs/reference/commands.md` — 검증 명령 인덱스

## Phase 4 스코프 (한 번에 한 Phase, PLAN.md Phase 4 done-criteria만)

PLAN.md Phase 4 핵심:
- **project별 octocrab**로 멀티 레포의 open/my PR 조회(페이지네이션). 토큰은 keychain(Phase 2 GitHub 토큰).
- 도출: CI 상태·conflict·draft·age·linked-backlog(`ticketKeyPattern` 조인).
- **readiness 버킷**(Needs Self Check / CI Blocked / Ready / Merged Cleanup / Stale) + 수동 self-check(로컬 상태).
- **PR 신호는 임계치 넘을 때만 매트릭스 escalate**(거울 아님 — INVARIANT #4), `dedup_key`로 **upsert**(INVARIANT #3), 원인 해소 시 **auto-resolve**.

**Done-criteria:**
- [ ] 두 프로젝트 PR이 버킷별 표시
- [ ] `CI failed + 오늘 마감 백로그 링크` → Q1에 1건
- [ ] 폴링 N회 반복해도 동일 PR 신호 중복 0 (dedup upsert)
- [ ] CI 통과로 바뀌면 해당 신호 auto-resolve

**설계 선결 과제(시작 전 결정):**
- **escalate 임계치:** 어떤 조건이 매트릭스로 올라오는가(예: CI failed + 마감 임박 + linked backlog). 사람이 임계치를 넘은 것만 결정 큐에 — 자동 분류 아님(항상 unclassified 진입, INVARIANT #1).
- **dedup 키 규약:** `pr:{repo}:{number}:{reason}` 형태 + auto-resolve 조건(CI green/merged).
- **폴링 모델:** bounded(무한 poll 금지 — INVARIANT #5). 수동 새로고침 vs 주기 폴링 + backoff.

## 운영 노트 (환경 함정)

- **Rust 툴체인:** cargo는 `$HOME/.cargo/bin`에 있으나 **기본 PATH에 없음**. cargo/`git commit`(husky pre-commit가 `cargo fmt --check`+`pnpm typecheck` 실행) 전 매번 `export PATH="$HOME/.cargo/bin:$PATH"`. cargo는 `--manifest-path src-tauri/Cargo.toml`로(백그라운드 셸은 cwd 유실 가능 → 절대경로/manifest-path 권장).
- **rtk 훅 주의:** `cargo clippy --all-targets -- -D warnings`는 rtk가 `-- -D warnings`를 망가뜨려 가짜 실패 + 요약("N errors") 오탐. → `rtk proxy cargo clippy --manifest-path .../Cargo.toml --all-targets -- -D warnings > /tmp/x.log 2>&1` 후 **Read 도구**로 raw 로그의 `Finished`/경고 0 확인. **`tail`/`cat`도 rtk가 망가뜨림 → 로그는 Read 도구로 본다.** 백그라운드 exit code도 못 믿음.
- **bindings.ts:** `cargo test`의 export 테스트가 생성(프런트 빌드 전 필요). 수기 IPC 타입 금지(specta). **specta는 i64/u64 export 금지** → 작은 정수는 `i32`/`u32`(FlushSummary는 u32).
- **GUI/실네트워크 검증:** 실제 창/핫키/keychain 영속/Notion·GitHub 실호출은 **사용자 관찰 항목**. 헤드리스에선 `cargo build/test/clippy` + `pnpm typecheck/build` + 필요시 `pnpm tauri dev` 부팅 로그. 실 keychain/network는 cargo test에 넣지 말 것.

## Git 워크플로우 (중요)

- **항상 `dev`에서 작업/커밋/push.** `main`은 PR(dev → main)로만 머지. `git push origin main`은 `.husky/pre-push`가 차단.
- 커밋 = Conventional Commits. 이슈 번호는 PR에만(커밋 메시지 금지). 한 PR = 한 관심사.
- gh 활성 계정이 가끔 `yanghapark`로 바뀜 → `gh auth switch --user 64etuor`로 고정.
- 레포: `64etuor/work-radar` (Private). CI(main·dev): rust fmt/clippy/test + frontend typecheck/build.

## 시작 명령(새 세션에 붙여넣기)

```
/oh-my-claudecode:ralph work-radar Phase 4 (GitHub PR Radar read 레일) 구현.
docs/HANDOFF.md → PLAN.md(§1 INVARIANTS + Phase 4) → docs/architecture.md(§3 멀티레포, §7 dedup/auto-resolve)
→ docs/decisions.md(Phase 2 octocrab·토큰) 순으로 읽고 따른다. 한 번에 한 Phase,
Phase 4 done-criteria로 자가검증. INVARIANTS 준수(특히 #3 dedup upsert·#4 임계치 escalate·
#5 bounded poll·토큰 keychain). 작업/푸시는 dev에만.
시작 전 escalate 임계치 + dedup 키 규약만 확인하고 진행.
```
