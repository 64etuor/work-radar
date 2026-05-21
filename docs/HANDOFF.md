# Work Radar — 세션 핸드오프 (현재: Phase 7 시작 직전)

> 새 세션은 **이 파일 + 아래 정본들**을 먼저 읽고 시작한다. 이전 대화 컨텍스트 없이도 진행 가능하도록 작성됨.

## 지금 상태

- **Phase 0~6 완료·검증됨.** 레포 `64etuor/work-radar`(Private), `dev`.
  - Phase 1 `6fecaff` · Phase 2 `d57f300` · Phase 3 `2e9f293` · Phase 4 `78ce36b` · Phase 5 `aed1b72` · Phase 6 = 이 세션(아직 커밋 전이면 dev에 커밋 필요).
- **Phase 5 완료(Worktree & Branch Diff Viewer — read-only):** `git.rs`(GitProvider/CliGitProvider, read 서브커맨드만, timeout bound) + 커맨드 4종 + WorktreeView. 상세 `docs/decisions.md` Phase 5. (커밋 `aed1b72`)
- **Phase 6 산출물(Notion↔PR status mismatch 감지 — 구현·검증됨):**
  - **마이그레이션 0005:** `projects.notion_done_statuses TEXT`(JSON 배열 — done으로 볼 Notion 상태 이름 목록). 스냅샷은 **신규 테이블 없음** — 기존 `signals.snapshot`(0001) 재사용.
  - **백엔드 `notion.rs`(read 신설):** `NotionReader` 트레잇(RPITIT, NotionWriter 패턴) + `HttpNotionReader`(`POST /databases/{id}/query`=read, bounded 페이지네이션 `MAX_QUERY_PAGES=10`×100, **상한 초과/cursor 누락 시 terminal Err** — 조용한 truncation 금지). 순수 파서 `extract_page_title`/`extract_page_status`(status 타입 우선→select)/`parse_query_response`.
  - **`commands.rs`:** `sync_mismatch<P:PrProvider,R:NotionReader>` 코어(Notion anchor 전체 fetch + PR 머지 조인 → drift= `PR merged & Notion≠done`만 → dedup upsert + auto-resolve), `upsert_mismatch_signal`(unclassified 진입+suggested `q3_quick_contain` 힌트, ON CONFLICT가 quadrant/status 보존), `auto_resolve_mismatch`(false-resolve 가드: Notion 사라짐/done은 신뢰, "PR 미머지"는 `all_repos_ok`일 때만), `is_done_status`/`parse_done_statuses`/`mismatch_dedup_key`. 커맨드 `refresh_mismatch(projectId)` + `set_notion_done_statuses(projectId, statuses)`.
  - **`models.rs`:** `Project.notionDoneStatuses`·`CreateProjectInput.notionDoneStatuses`·`WorkSignal.snapshot` 노출 + `MismatchItem`(projectId·ticket·prUrl·notionUrl·notionStatus?·escalated) DTO. **`lib.rs`** 커맨드 2종 등록. bindings 재생성.
  - **프런트:** `query.ts` `fetchMismatch`/`useSetNotionDoneStatuses`/`MISMATCH_POLL_MS`(5분). `store.ts` View+=`mismatch`. `App.tsx` 5-way 렌더+Esc. `CommandPalette` "Status Mismatch로". `MismatchView`(프로젝트별 폴링·drift 카드·PR/백로그 열기 — `.pr-*` CSS 재사용). `ProjectCard` done 상태 편집기(`.st-done`).
  - **사용자 결정(AskUserQuestion):** done 판정=프로젝트별 상태 이름 목록 / read 범위=backlog DB 전체 query / drift 방향=정본 케이스(PR merged + Notion≠done)만. 상세 `docs/decisions.md` Phase 6.
  - **검증:** `cargo test` **67 passed**(mismatch 9 + notion 파서 3 + is_done/parse 2) · `cargo clippy -D warnings` clean · `pnpm typecheck`/`build` green · `cargo fmt` 적용 · INVARIANTS reviewer(critic) 패스 = **7개 PASS**(MAJOR #1 truncation→Err·MAJOR #3 부분실패 가드 테스트 수정 반영, MAJOR #2 멀티패턴 제약은 문서화).
- **다음 = Phase 7 (Agent 스파인 — Codex 기능 전 뼈대만)** — `dev` 브랜치에서.

### Phase 6 미해결/관찰 항목 (Phase 7+에서 고려)

- **실 Notion/GitHub 호출 미관찰(헤드리스 한계):** 실제 백로그 query·상태 추출·drift 카드 렌더는 사용자가 `pnpm tauri dev` + 실 토큰/백로그로 확인(PR Radar 실네트워크와 동일). cargo test는 fake `NotionReader`/`PrProvider` + 순수 파서로 검증(실 네트워크 없음).
- **알려진 제약(reviewer MAJOR #2, 문서화):** repo가 project와 다른 `ticketKeyPattern`을 쓰면 Notion(project 패턴)↔PR(repo 패턴) 조인 키가 어긋나 drift를 놓칠 수 있음(noise는 안 늚 — INVARIANT 위반 아님). 단일 패턴/프로젝트가 현재 전제. 같은 ticket의 중복 백로그 페이지는 첫 페이지만 본다.
- **mismatch 해소 초안(Phase 9):** Notion 업데이트 draft 자동 제안(suggestion 레일)은 Phase 9. Phase 6은 감지/escalate까지(해소는 사람이 수동, INVARIANT #2).
- **PR 재fetch 비효율:** MismatchView가 PR Radar와 별도로 PR을 fetch(bounded라 허용). 공통화는 추후.

## 먼저 읽을 정본

1. `PLAN.md` — §1 INVARIANTS(절대규칙 7개) + **Phase 7** Deliverables/Done-criteria
2. `docs/architecture.md` — §4 data model(`AgentRun` 모델), §5 AgentRunner(Rust trait + CodexRunner 골격), §2 3-Rail(제안/실행 레일)
3. `docs/decisions.md` — Phase 3(Notion)·Phase 4(PR Radar)·Phase 5(worktree)·Phase 6(mismatch) 결정
4. `.claude/skills/{octocrab-keyring,sqlx-sqlite,tauri-specta-ipc,codex-worktree-runner}` · `DESIGN.md` · `AGENTS.md` · `docs/reference/commands.md`(검증 명령)

## Phase 7 스코프 (한 번에 한 Phase, PLAN.md Phase 7 done-criteria만)

PLAN.md Phase 7 핵심 — **Agent 스파인(Codex 기능 전, 뼈대만):**
- `AgentRun` 모델 + 잡 큐(동시 1~2) + bounds(timeout/turns/cost cap) + **kill switch** + Jobs 뷰.
- `AgentRunner` trait + `CodexRunner`(=`codex exec --json`, read-only 샌드박스, worktree).
- codex 미설치/미인증 시 **graceful degrade**(앱 핵심 100% 동작).

**Done-criteria(요약):** echo 잡이 bound 내 실행·Jobs 뷰 표시·kill 동작·로그 캡처 / timeout·cost cap 초과 시 kill+failed / codex 없을 때 자동화 UI 비활성·나머지 정상.

**설계 선결 과제(시작 전 결정 권장 — AskUserQuestion):**
- **Codex CLI 플래그 확인:** `exec`/`--json`/`--sandbox`/`--cd`/`-a` 실제 설치본 검증(architecture §5 주의). 미설치 감지 방식(PATH/`which`).
- **잡 큐 영속:** `agent_runs` 테이블(0001에 이미 존재)에 영속 vs 인메모리. kill switch/동시성 제어 위치(tokio task + CancellationToken).
- **`AgentRun` 스키마 정합:** 0001 `agent_runs` 컬럼(engine/kind/rail/sandbox/bounds/retry/status)과 architecture §4 모델 매핑 — 신규 마이그레이션 필요 여부.
- **INVARIANT #5/#6:** 모든 잡 bound(timeout+turns+cost cap+kill) 강제, 코드 잡은 worktree 격리·기본 read-only(danger 금지).

## 운영 노트 (환경 함정)

- **Rust 툴체인:** cargo는 `$HOME/.cargo/bin`에 있으나 **기본 PATH에 없음**. cargo/`git commit`(husky pre-commit가 `cargo fmt --check`+`pnpm typecheck`) 전 매번 `export PATH="$HOME/.cargo/bin:$PATH"`. cargo는 `--manifest-path src-tauri/Cargo.toml`로.
- **rtk 훅 주의:** `cargo clippy ... -- -D warnings`·`tail`·`cat`을 rtk가 망가뜨려 **exit 0으로 가리거나** 가짜 요약을 낸다 → `rtk proxy <cmd> > /tmp/x.log 2>&1` 후 **Read 도구**로 raw 로그의 `Finished`/`test result`/경고 0 확인.
- **bindings.ts:** `cargo test`의 export 테스트가 생성. 수기 IPC 타입 금지(specta). **specta는 i64/u64 export 금지** → 작은 정수는 `i32`/`u32`(Worktree.ahead/behind, DiffFileSummary.adds/dels = u32).
- **GUI/실네트워크/실 git 검증:** 실제 창·핫키·keychain 영속·Notion/GitHub 실호출·실 git 셸아웃은 **사용자 관찰 항목**. 헤드리스에선 `cargo build/test/clippy` + `pnpm typecheck/build` + 필요시 `pnpm tauri dev` 부팅 로그. 실 keychain/network/git은 cargo test에 넣지 말 것.
- **CI(.github/workflows/ci.yml):** rust(fmt/clippy/test) + frontend(typecheck/build)만. (decisions.md가 언급한 scripts/check-*.sh 가드는 현재 레포에 없음.)

## Git 워크플로우 (중요)

- **항상 `dev`에서 작업/커밋/push.** `main`은 PR(dev → main)로만 머지. `git push origin main`은 `.husky/pre-push`가 차단.
- 커밋 = Conventional Commits. 이슈 번호는 PR에만(커밋 메시지 금지). 한 PR = 한 관심사.
- gh 활성 계정이 가끔 `yanghapark`로 바뀜 → `gh auth switch --user 64etuor`로 고정.
- 레포: `64etuor/work-radar` (Private).

## 시작 명령(새 세션에 붙여넣기)

```
work-radar Phase 7 (Agent 스파인 — Codex 기능 전 뼈대만) 구현.
docs/HANDOFF.md → PLAN.md(§1 INVARIANTS + Phase 7) → docs/architecture.md(§4 AgentRun, §5 AgentRunner, §2 3-Rail)
→ docs/decisions.md 순으로 읽고 따른다. 한 번에 한 Phase, Phase 7 done-criteria로 자가검증.
INVARIANTS 준수(특히 #5 모든 잡 bound=timeout/turns/cost cap/kill, #6 worktree 격리+read-only, #2 Acceptance 게이트). 작업/푸시는 dev에만.
시작 전 Codex CLI 플래그(실 설치본) + 잡 큐 영속(agent_runs 테이블) + kill/동시성 방식만 확인하고 진행.
```
