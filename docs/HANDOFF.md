# Work Radar — 세션 핸드오프 (현재: Phase 5 시작 직전)

> 새 세션은 **이 파일 + 아래 정본들**을 먼저 읽고 시작한다. 이전 대화 컨텍스트 없이도 진행 가능하도록 작성됨.

## 지금 상태

- **Phase 0~4 완료·검증·커밋·푸시됨.** 레포 `64etuor/work-radar`(Private), `dev` 푸시.
  - Phase 1 `6fecaff` · Phase 2 `d57f300` · Phase 3 `2e9f293` · Phase 4 = 이 세션 커밋(dev).
- **Phase 4 산출물(GitHub PR Radar — read 레일, 구현됨):**
  - **마이그레이션 0004** `pr_self_checks`(repo_full_name, pr_number UNIQUE) — 수동 self-check 로컬 상태(routine_checks 패턴). PR Radar 항목 자체는 매 폴링마다 GitHub에서 새로 fetch되는 ambient라 영속 테이블 없음.
  - **백엔드 `github.rs`(신규):** `GithubError{Transient,Terminal}` + `with_retry`(시도 캡 3 + 지수 backoff + jitter, terminal 재시도 안 함), `classify_octocrab`(429/5xx/hyper=Transient, 4xx/디코드=Terminal), `aggregate_ci`(check-runs conclusion 집계), `parse_owner_repo`(URL/plain/.git), `PrProvider` 트레잇(RPITIT) + `HttpPrProvider`(octocrab: open PR bounded 페이지네이션 + per-PR check-runs + closed 1페이지 최근 merged). `RawPr`/`RawPrState` 내부 전용.
  - **`commands.rs`:** `classify_bucket`(우선순위 Merged Cleanup > CI Blocked(CI 실패/conflict) > Stale > Needs Self Check(draft/미체크) > Ready), `extract_ticket`(regex graceful), `escalation_reason`(open && CI Failing && 링크 티켓), `upsert_pr_signal`(`ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE` — **quadrant/status 미덮음**, suggested q1 힌트), `auto_resolve`(active set 밖 + fetched repo 범위 → done), `sync_pr_radar<P:PrProvider>` 코어(fake provider 테스트), 커맨드 `refresh_pr_radar`/`set_pr_self_check`, `fetch_github_repo_refs`.
  - **`lib.rs`:** `mod github` + 커맨드 2종 등록. **`Cargo.toml`:** `regex`, `chrono`(clock). bindings 재생성(refreshPrRadar/setPrSelfCheck + PrRadarItem/ReadinessBucket/CiStatus).
  - **프런트:** `query.ts` `fetchPrRadar`/`useSetPrSelfCheck` + `PR_RADAR_POLL_MS`. `store.ts` View+=`radar`. `App.tsx` 3-way 렌더 + Esc. `CommandPalette` "PR Radar로". `PrRadarView`(useQueries 프로젝트별 **주기 폴링 + bounded retry**, 5버킷 그룹, PrCard: CI/conflict/draft/ticket/age/escalated 배지 + self-check 토글 + 열기). `styles.css` `.pr-*`(white editorial).
  - **사용자 결정(세션 시작 전 AskUserQuestion):** escalate 임계치=CI 실패+링크 티켓 / 진입=unclassified+suggested q1 힌트(INVARIANT #1) / dedup=`pr:{owner}/{repo}:{number}:{reason}`·CI green·merged 시 auto-resolve / 폴링=주기 폴링+backoff. 상세는 `docs/decisions.md` Phase 4.
- **다음 = Phase 5 (Worktree & Branch Diff Viewer)** — `dev` 브랜치에서.

### Phase 4 미해결/관찰 항목 (Phase 5+에서 고려)

- **실 네트워크 미관찰(헤드리스 한계):** 실제 GitHub PR fetch·CI/conflict 도출·실제 주기 폴링/escalate는 사용자가 `pnpm tauri dev` + 실 토큰/레포로 확인(Phase 2 octocrab ping과 동일). cargo test는 fake `PrProvider` + 순수 로직(버킷/escalate/dedup/auto-resolve/CI 집계/retry)으로 검증.
- **마감일 기반 escalate 미구현:** done-criteria의 "오늘 마감 백로그 링크"에서 *마감일*은 Notion 백로그 내용 미러가 없어 Phase 4에선 도출 불가 → "링크 티켓 존재"로 임계치 정의. 마감일 정교화는 Notion 미러가 생기는 **Phase 6**로 연기.
- **항상-on 백그라운드 폴링 미도입:** 폴링은 PR Radar 뷰가 마운트된 동안만(refetchInterval). 뷰를 안 봐도 도는 Rust 백그라운드 태스크(라이프사이클/킬스위치)는 Phase 4 범위에서 제외 — 필요 시 추후.
- **Merged Cleanup 범위:** closed PR 최근 1페이지(`merged_at` ≤14일)만 본다(per-PR CI 호출 없이 bounded). 더 넓은 정리 뷰는 추후.
- **escalate 신호 매트릭스 표시:** PR escalate 신호는 source=github_pr로 미분류 트레이에 카드로 뜬다(suggested q1 힌트). 카드에 source/CI 배지·suggested 힌트 시각화는 시각 폴리시(추후).

## 먼저 읽을 정본

1. `PLAN.md` — §1 INVARIANTS(절대규칙 7개) + **Phase 5** Deliverables/Done-criteria
2. `docs/architecture.md` — §8 Worktree & Branch Diff(Phase 5), §3 멀티 레포, §4 data model(`Worktree`/`DiffFileSummary`)
3. `docs/decisions.md` — Phase 2(토큰·octocrab) / Phase 4(PR Radar) 결정
4. `.claude/skills/{octocrab-keyring,sqlx-sqlite,tauri-specta-ipc,codex-worktree-runner}` · `DESIGN.md`(토큰/컴포넌트 정본) · `AGENTS.md`(working agreement) · `docs/reference/commands.md`(검증 명령)

## Phase 5 스코프 (한 번에 한 Phase, PLAN.md Phase 5 done-criteria만)

PLAN.md Phase 5 핵심:
- repo별 `git worktree list` + 브랜치 목록 (Rust: git2 또는 git CLI 셸아웃 — **git 접근은 Rust에**).
- `Worktree` 모델: path · branch · head · baseBranch · ahead/behind · dirty 상태.
- Diff 뷰 비교 모드 4종: `working`(미커밋) / `staged` / `vs_base`(3-dot merge-base) / `branch↔branch`.
- 파일 목록(+adds/-dels, status M/A/D/R) + 파일별 diff(구문 강조), 대용량 diff 비차단(지연/가상 로드).
- PR Radar/실행 레일과 연결: PR 브랜치·Codex worktree diff를 같은 뷰로 검수. **read-only**(체크아웃/리셋 없음).

**Done-criteria(요약):** worktree가 상태 배지(ahead/behind/dirty)와 표시 / worktree 선택 → 파일+파일별 diff / 비교 모드 4종 / 멀티 repo projectId 필터 / 대용량 diff UI 비차단.

**설계 선결 과제(시작 전 결정 권장):**
- **git 접근 방식:** git2(libgit2) vs `git` CLI 셸아웃 — 어느 것을(또는 혼합) 쓸지. 새 크레이트 추가 트레이드오프.
- **새 스키마 필요 여부:** `Worktree`는 매번 `git worktree list`로 도출(ambient) → 영속 불필요할 수 있음(PR Radar처럼). 캐시/스냅샷이 필요한지.
- **대용량 diff 전략:** 파일 목록 먼저 + 파일별 hunk 지연 로드 + 가상 스크롤 임계치.

## 운영 노트 (환경 함정)

- **Rust 툴체인:** cargo는 `$HOME/.cargo/bin`에 있으나 **기본 PATH에 없음**. cargo/`git commit`(husky pre-commit가 `cargo fmt --check`+`pnpm typecheck`) 전 매번 `export PATH="$HOME/.cargo/bin:$PATH"`. cargo는 `--manifest-path src-tauri/Cargo.toml`로.
- **rtk 훅 주의:** `cargo clippy ... -- -D warnings`를 rtk가 망가뜨려 **exit code를 0으로 가리거나** 가짜 요약을 낸다 → `rtk proxy cargo clippy --manifest-path .../Cargo.toml --all-targets -- -D warnings > /tmp/x.log 2>&1` 후 **Read 도구**로 raw 로그의 `Finished`/경고 0 확인. **`tail`/`cat`도 rtk가 망가뜨림 → 로그는 Read 도구로 본다.** (Phase 4에서 clippy dead-code 2건이 exit 0 뒤에 숨어 있었음 — 반드시 raw 로그 확인.)
- **bindings.ts:** `cargo test`의 export 테스트가 생성. 수기 IPC 타입 금지(specta). **specta는 i64/u64 export 금지** → 작은 정수는 `i32`/`u32`(PrRadarItem.number/ageDays = u32).
- **GUI/실네트워크 검증:** 실제 창/핫키/keychain 영속/Notion·GitHub 실호출은 **사용자 관찰 항목**. 헤드리스에선 `cargo build/test/clippy` + `pnpm typecheck/build` + 필요시 `pnpm tauri dev` 부팅 로그. 실 keychain/network는 cargo test에 넣지 말 것.
- **CI(.github/workflows/ci.yml):** rust(fmt/clippy/test) + frontend(typecheck/build)만. (decisions.md가 언급한 scripts/check-*.sh 가드는 현재 레포에 없음 — CI는 위 5개만 강제.)

## Git 워크플로우 (중요)

- **항상 `dev`에서 작업/커밋/push.** `main`은 PR(dev → main)로만 머지. `git push origin main`은 `.husky/pre-push`가 차단.
- 커밋 = Conventional Commits. 이슈 번호는 PR에만(커밋 메시지 금지). 한 PR = 한 관심사.
- gh 활성 계정이 가끔 `yanghapark`로 바뀜 → `gh auth switch --user 64etuor`로 고정.
- 레포: `64etuor/work-radar` (Private).

## 시작 명령(새 세션에 붙여넣기)

```
/oh-my-claudecode:ralph work-radar Phase 5 (Worktree & Branch Diff Viewer) 구현.
docs/HANDOFF.md → PLAN.md(§1 INVARIANTS + Phase 5) → docs/architecture.md(§8 Worktree & Branch Diff, §3 멀티레포)
→ docs/decisions.md 순으로 읽고 따른다. 한 번에 한 Phase, Phase 5 done-criteria로 자가검증.
INVARIANTS 준수(특히 #6 worktree 격리·사용자 트리 무손상, git 접근은 Rust, read-only diff). 작업/푸시는 dev에만.
시작 전 git 접근 방식(git2 vs CLI) + Worktree 영속 필요 여부만 확인하고 진행.
```
