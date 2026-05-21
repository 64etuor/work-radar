# Work Radar — 세션 핸드오프 (현재: Phase 6 시작 직전)

> 새 세션은 **이 파일 + 아래 정본들**을 먼저 읽고 시작한다. 이전 대화 컨텍스트 없이도 진행 가능하도록 작성됨.

## 지금 상태

- **Phase 0~5 완료·검증됨.** 레포 `64etuor/work-radar`(Private), `dev`.
  - Phase 1 `6fecaff` · Phase 2 `d57f300` · Phase 3 `2e9f293` · Phase 4 `78ce36b` · Phase 5 = 이 세션(아직 커밋 전이면 dev에 커밋 필요).
- **Phase 5 산출물(Worktree & Branch Diff Viewer — read-only, 구현·검증됨):**
  - **신규 마이그레이션 없음(ambient).** worktree/diff는 PR Radar처럼 매 호출 git에서 fresh 도출 — DTO만 정의, DB 영속 없음.
  - **백엔드 `git.rs`(신규):** `GitError`(terminal only — 로컬 git은 재시도 무의미), `GitProvider` 트레잇(RPITIT, PrProvider 패턴) + `CliGitProvider`(`git` CLI 셸아웃, 각 호출 `timeout`(20s) bound, `-c color.ui=false`). **read 서브커맨드만**(worktree list / status / for-each-ref / diff) — checkout/reset/commit 등 mutating 0건(INVARIANT #6). 순수 파서: `parse_worktree_list`(porcelain 블록), `parse_status_v2`(ahead/behind/dirty), `parse_numstat`/`parse_name_status`(rename old_path 포함) + `merge_diff_summary`, `parse_branches`(`*/HEAD` 제외), `diff_range_args`(4모드, `-`-prefix ref 거부=arg injection 가드), `summarize_status`(Diverged>Dirty>Ahead>Behind>Clean).
  - **`commands.rs`:** `fetch_local_repo_refs`(enabled + local_path 보유 레포, projectId 필터 또는 전체, 라벨=remote owner/repo 또는 basename), `collect_worktrees<G:GitProvider>` 코어(repo별 실패 격리·전부 실패면 Err·bare/status실패 worktree 제외·fake provider 테스트), 커맨드 4종: `list_worktrees(projectId?)` / `list_worktree_branches(path)` / `worktree_diff_files(path,mode,base?,head?)` / `worktree_file_diff(...,path)`.
  - **`models.rs`:** `Worktree`(id=`{repoId}:{path}`·branch?·head·baseBranch·isPrimary·status·dirty·ahead/behind(u32)·lastFetchedAt), `WorktreeStatus`(clean/dirty/ahead/behind/diverged), `DiffMode`(working/staged/vs_base/branch_branch), `FileChange`(serde rename → `"M"/"A"/"D"/"R"`), `DiffFileSummary`(path·status·adds/dels(u32)·oldPath?·binary). **`lib.rs`:** `mod git` + 커맨드 4종 등록. bindings 재생성. **신규 의존성/권한 없음**(git=CLI, opener 재사용 안 함 — 외부 열기 없음).
  - **프런트:** `query.ts` `useWorktrees`/`useWorktreeBranches`/`useWorktreeDiffFiles`/`useWorktreeFileDiff`(폴링 없음 — 로컬·on-demand, 파일별 diff는 `enabled` 지연 로드). `store.ts` View+=`worktree`. `App.tsx` 4-way 렌더 + Esc. `CommandPalette` "Worktree Diff로". `WorktreeView`(프로젝트 필터·repo별 그룹·worktree 상태배지(dirty/↑ahead/↓behind/clean)·4모드 탭·vs_base/branch↔branch ref picker·파일목록 먼저+파일별 diff·diff-line 색칠 + content-visibility 블록 가상화 + `MAX_DIFF_LINES=6000` 잘라 비차단). `styles.css` `.wt-*`(white editorial).
  - **사용자 결정(세션 시작 전 AskUserQuestion):** git 접근=`git` CLI 셸아웃(git2 아님) / 영속=없음(ambient 도출). 상세는 `docs/decisions.md` Phase 5.
  - **검증:** `cargo test` 53 passed(신규 git 파서 6 + collect/refs 3) · `cargo clippy -D warnings` clean · `pnpm typecheck`/`build` green · INVARIANTS reviewer 패스 = **7개 위반 0**(read-only #6 엄수 확인).
- **다음 = Phase 6 (status mismatch 감지)** — `dev` 브랜치에서.

### Phase 5 미해결/관찰 항목 (Phase 6+에서 고려)

- **실 git 실행 미관찰(헤드리스 한계):** 실제 worktree 나열·status 배지·4모드 diff·구문강조 렌더는 사용자가 `pnpm tauri dev` + 실 local 레포로 확인(PR Radar 실네트워크와 동일). cargo test는 fake `GitProvider` + 순수 파서로 검증(git이 테스트 PATH에 없을 수 있어 실 git은 제외).
- **deferred(reviewer LOW/NIT, 미적용):** (1) `worktree_path`가 `list_worktrees` 반환 집합에 속하는지 미검증(렌더러 신뢰 경계 — 방어심화, read-only라 무해). (2) branch↔branch ref가 `..`/`HEAD@{0}` 등이어도 통과(picker 출처라 위험 낮음, `-`-prefix·`--`는 거부됨). (3) `useWorktreeBranches`가 repo 아닌 worktree 경로로 캐싱(동일 repo 중복 fetch). 필요 시 추후.
- **외부 에디터/PR 연결:** PR Radar PR 브랜치·실행 레일(Phase 10) Codex worktree를 같은 Diff 뷰로 검수하는 연결은 데이터/뷰 준비됨 — 실제 wiring은 해당 Phase에서.

## 먼저 읽을 정본

1. `PLAN.md` — §1 INVARIANTS(절대규칙 7개) + **Phase 6** Deliverables/Done-criteria
2. `docs/architecture.md` — §4 data model(`WorkSignal.snapshot` drift 비교), §6 SSOT, §7 dedup/auto-resolve, §3 멀티 레포(join key=`ticketKeyPattern`)
3. `docs/decisions.md` — Phase 3(Notion)·Phase 4(PR Radar)·Phase 5(worktree) 결정
4. `.claude/skills/{octocrab-keyring,sqlx-sqlite,tauri-specta-ipc}` · `DESIGN.md` · `AGENTS.md` · `docs/reference/commands.md`(검증 명령)

## Phase 6 스코프 (한 번에 한 Phase, PLAN.md Phase 6 done-criteria만)

PLAN.md Phase 6 핵심 — **Notion↔PR drift 감지(차별점):**
- 티켓별 마지막 PR/Notion 스냅샷 저장 → drift 감지 → mismatch 신호(dedup + auto-resolve).
- join key = `ticketKeyPattern`(Phase 4 `extract_ticket` 재사용). 매칭 실패는 **신호를 만들지 않는다**(noise 0).

**Done-criteria(요약):** "Notion Doing + PR Merged" 시뮬 → mismatch 정확히 1건 / Notion 갱신 시 mismatch auto-resolve / join key 매칭 실패가 noise를 만들지 않음.

**설계 선결 과제(시작 전 결정 권장):**
- **스냅샷 저장 위치:** `WorkSignal.snapshot`(architecture §4 `prState?`/`notionState?`) 컬럼 신설 vs 별도 스냅샷 테이블 — 마이그레이션 필요 여부.
- **Notion 상태 read:** Phase 3는 write만 했고 read 미러가 없음 → mismatch 비교용 Notion 상태(예: Status 속성) read를 어디까지 도입할지(백로그 항목별 status 폴링 범위·rate limit).
- **mismatch 임계/방향:** 어떤 (PR상태, Notion상태) 조합을 drift로 볼지(예: PR merged + Notion≠Done) — INVARIANT #1(자동 분류 금지) 준수, escalate는 suggested 힌트만.

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
work-radar Phase 6 (Notion↔PR status mismatch 감지) 구현.
docs/HANDOFF.md → PLAN.md(§1 INVARIANTS + Phase 6) → docs/architecture.md(§4 snapshot, §6 SSOT, §7 dedup/auto-resolve)
→ docs/decisions.md 순으로 읽고 따른다. 한 번에 한 Phase, Phase 6 done-criteria로 자가검증.
INVARIANTS 준수(특히 #3 dedup+auto-resolve, #1 자동 분류 금지=suggested 힌트만, #7 SSOT). 작업/푸시는 dev에만.
시작 전 스냅샷 저장 위치(WorkSignal.snapshot 컬럼 vs 별도 테이블) + Notion 상태 read 범위만 확인하고 진행.
```
