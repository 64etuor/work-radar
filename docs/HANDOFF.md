# Work Radar — 세션 핸드오프 (현재: Phase 10 시작 직전)

> 새 세션은 **이 파일 + 아래 정본들**을 먼저 읽고 시작한다. 이전 대화 컨텍스트 없이도 진행 가능하도록 작성됨.

## 지금 상태

- **Phase 0~9 완료·검증됨.** 레포 `64etuor/work-radar`(Private), `dev`.
  - Phase 4 `78ce36b` · Phase 5 `aed1b72` · Phase 6 `0276259` · Phase 7 `6294e22` · Phase 8 `dfbebb4` · Phase 9 = 이 세션(아직 커밋 전이면 dev에 커밋 필요).
- **Phase 7 산출물(Agent 스파인 — Codex 기능 전 뼈대; 구현·검증됨):**
  - **`agent.rs`(신설):** `AgentRunner` 트레잇(RPITIT, GitProvider 패턴) + `EchoRunner`(codex 없이 bound/kill/로그 검증용 셸아웃 — 고정 스크립트+위치인자, 인젝션 없음) + `CodexRunner`(`codex exec --json --sandbox read-only --color never -C <cwd> --skip-git-repo-check -- <prompt>`) + `Bounds`/`AgentError`/`AgentOutcome` + 순수 `parse_codex_event`/`BoundsTracker`(max_turns·cost_cap 트립) + codex 감지(`resolve_codex_bin`/`codex_availability`).
  - **`jobs.rs`(신설):** `JobManager`(managed state) — tokio `Semaphore(1)` 동시성 + `Mutex<HashMap<run_id, CancellationToken>>` kill 레지스트리 + codex_bin/worktree_root/logs_dir. `spawn`(INSERT proposed → permit → running → `tokio::select!`(run, sleep(timeout), cancel) → succeeded/failed/cancelled 영속 + 로그) + `kill`(큐 대기 중에도 가능). agent_runs INSERT/UPDATE/fetch/log-tail 헬퍼.
  - **`models.rs`:** `Engine`/`AgentRail`/`Sandbox`(read_only|workspace_write — **danger_full 없음**)/`AgentStatus` enum + `AgentRunView`(i64 record→u32/f64 변환) + `CodexAvailability` + `TriggerEchoInput`/`TriggerCodexInput`.
  - **`commands.rs`:** `codex_status` · `trigger_echo_job` · `trigger_codex_job`(미설치/미인증 시 Err) · `list_agent_runs` · `kill_agent_run` · `read_agent_log`. **`lib.rs`** 6커맨드 등록 + `JobManager` manage(setup에서 codex 경로 해석). bindings 재생성. **`Cargo.toml`** `tokio-util`(CancellationToken) 추가.
  - **프런트:** `query.ts` `useCodexStatus`/`useAgentRuns`(active면 2s 폴링)/`useTriggerEchoJob`/`useTriggerCodexJob`/`useKillAgentRun`/`useAgentLog` + `JOBS_POLL_MS`. `store.ts` View+=`jobs`. `App.tsx` 6-way 렌더+Esc. `CommandPalette` "Jobs (Agent)로". `JobsView`(codex 가용성 배너로 graceful degrade · 테스트 잡 버튼 echo/timeout · codex 프롬프트 폼 · 잡 카드 상태배지/bounds/cost · kill · 로그 패널). `styles.css` `.jobs-*`(.pr-* 토큰 재사용).
  - **사용자 결정(AskUserQuestion):** 잡 큐=agent_runs 영속 / 동시=1 / echo 검증=EchoRunner+Jobs 버튼. 상세 `docs/decisions.md` Phase 7.
  - **검증:** `cargo test` **74 passed**(agent 4 + jobs 3 신규) · `cargo clippy -D warnings` clean · `pnpm typecheck`/`build` green · `cargo fmt` 적용 · INVARIANTS reviewer(critic) **7개 PASS / done-criteria 3개 PASS, BLOCKER·MAJOR 0**(reviewer 트레이드오프: 동기 Drop worktree 정리·best-effort cost cap은 decisions.md에 문서화).
- **Phase 8 산출물(첫 자동화: PR self-check 자동 초안 — suggestion 레일 + Acceptance 게이트; 구현·검증됨):**
  - **`github.rs`:** `PrProvider::fetch_pr_diff`(octocrab `get_diff` + bounded `with_retry`) + `cap_diff`(256KB 상한).
  - **`agent.rs`:** `CodexRunner.input_files`(잡 시작 전 cwd에 `pr.diff` 기록) + `proposal_from_message`(JSON 객체/```json 펜스 보존, 아니면 `{"raw":…}` fallback).
  - **`jobs.rs`:** `spawn(gated)` + `finalize(gated)` — 게이트 잡 성공+proposal이면 `awaiting_approval`로 마감(아니면 succeeded). `AgentRunView`에 `trigger`/`has_proposal` 노출(SELECT+레코드 확장).
  - **`commands.rs`:** `trigger_pr_selfcheck`(diff fetch→worktree codex 잡, gated) · `pr_proposal`(타입 파싱, raw면 Err) · `accept_proposal`(acceptances 행 + 로컬 pr_self_checks + status succeeded — **외부 무변경**) · `reject_proposal`(cancelled). `resolve_selfcheck_repo`(repo_full_name→local_path+GitHub 토큰). **`lib.rs`** 4커맨드 등록. **`models.rs`** `PrSelfCheckProposal`/`SelfCheckItem`/`TriggerPrSelfCheckInput`.
  - **프런트:** `query.ts` `useTriggerPrSelfcheck`/`usePrProposal`/`useAcceptProposal`/`useRejectProposal`. `PrRadarView` 카드 'self-check 초안' 버튼(codex 게이트, 머지 PR 제외 → 트리거 후 Jobs로). `JobsView` `ProposalPanel`(awaiting_approval 잡 — 편집 가능 self-check/설명 + accept/reject + "제출은 수동" 안내 + PR 링크). `styles.css` `.pr-draft`/`.jobs-prop-*`.
  - **사용자 결정(AskUserQuestion):** diff=GitHub fetch / 스키마=프롬프트 지시 JSON / Acceptance=awaiting_approval 게이트 / 트리거=PR Radar 카드(review는 Jobs). 상세 `docs/decisions.md` Phase 8.
  - **검증:** `cargo test` **80 passed**(+6) · clippy -D warnings clean · pnpm typecheck/build green · cargo fmt · 신규 마이그레이션 없음(acceptances/pr_self_checks/agent_runs 재사용).
- **Phase 9 산출물(추가 suggestion 자동화: enrich / CI triage / mismatch 초안 — 모두 제안 레일 + Acceptance 게이트; 구현·검증됨):**
  - **`models.rs`:** `TriggerEnrichInput`/`EnrichProposal`(suggested_quadrant·suggested_area는 `Quadrant`/`AreaTag` 닫힌 enum → 세트 밖 값 파싱 거부) · `TriggerCiTriageInput`/`CiTriageProposal`/`TriageOutcome`(run_id·escalated) · `TriggerMismatchDraftInput`/`NotionUpdateProposal`.
  - **`jobs.rs`:** `NewAgentRun`에 `retry_key`/`retry_count` 추가(0001 컬럼 첫 사용) + INSERT 반영.
  - **`commands.rs`:** 공통 코어(`require_codex`/`run_status_trigger`/`run_proposal_raw`/`parse_proposal<T>`(raw fallback Err)/`record_acceptance`(sqlx만 — 외부 무변경)). enrich: `trigger_enrich`(비-레포 `card.txt`)·`enrich_proposal`·`execute_accept_enrich`(suggested_*만, quadrant/area 무변경)·`accept_enrich`·`set_signal_area`(사람 area 확정, 별개 축). CI triage: `TRIAGE_RETRY_CAP=3`·`count_triage_runs`·`escalate_triage_to_q1`(unclassified+q1 힌트 dedup)·`trigger_ci_triage`(캡 초과면 잡 대신 escalate)·`triage_proposal`·`accept_triage`. mismatch: `trigger_mismatch_draft`(비-레포 `mismatch.json`)·`mismatch_draft_proposal`·`execute_accept_mismatch_draft`(로컬 resolve, Notion 무변경)·`accept_mismatch_draft`. **`lib.rs`** 10커맨드 등록.
  - **프런트:** `query.ts` 10훅(useTriggerEnrich/useEnrichProposal/useAcceptEnrich/useSetSignalArea/useTriggerCiTriage/useTriageProposal/useAcceptTriage/useTriggerMismatchDraft/useMismatchDraftProposal/useAcceptMismatchDraft). `JobsView`는 `ProposalPanel` 디스패처(kind별 SelfCheck/Enrich/Triage/MismatchDraft 패널). `CardMenu` 'AI 제안' 액션(codex 게이트). `MatrixCanvas` 카드에 제안 영역(dashed, 클릭해 확정)·제안 사분면(Q? dashed) 칩. `PrRadarView` CI Blocked 카드 'CI triage' 버튼. `MismatchView` '해소 초안' 버튼. `board-utils` areaLabel/suggestedQuadrantBadge. `styles.css` `.chip-area`/`.chip-area-sug`/`.chip-q-sug`/`.jobs-prop-select`.
  - **사용자 결정(AskUserQuestion):** enrich 트리거=카드 ⋯ 메뉴 / CI triage 캡=PR 단위 3회 / mismatch accept=로컬 기록만. 상세 `docs/decisions.md` Phase 9.
  - **검증:** `cargo test` **85 passed**(+5: enrich 파싱/accept, triage 파싱/캡 escalate, mismatch accept resolve) · clippy -D warnings clean · cargo fmt(--check green) · pnpm typecheck/build green(1758 modules) · INVARIANTS reviewer(critic) **7개 PASS / done-criteria 4개 PASS, BLOCKER·MAJOR 0**(MINOR 2: triage 캡이 실패 잡도 카운트=fail-toward-human 의도·문서화 / mismatch 로컬 resolve가 실 Notion 미수정 시 drift 가림=문서화된 트레이드오프).
- **다음 = Phase 10 (실행 레일 — 승격 백로그를 Codex가 격리 worktree에서 구현 → draft PR; 최고 위험, 마지막 자동화)** — `dev` 브랜치에서.

### Phase 9 미해결/관찰 항목 (Phase 10+에서 고려)

- **실 codex 실행 미관찰(헤드리스 한계):** enrich/triage/mismatch-draft의 gated finalize·proposal 파싱·accept는 cargo test로 검증했으나, 실제 `codex exec`가 `card.txt`/`pr.diff`/`mismatch.json`을 읽어 형식 JSON을 내는지는 사용자가 `pnpm tauri dev`+로그인 codex에서 확인(카드 'AI 제안' / PR Radar 'CI triage' / Mismatch '해소 초안' → Jobs awaiting_approval → accept).
- **mismatch 로컬 resolve가 실 Notion drift를 가릴 수 있음(reviewer MINOR, 문서화):** accept하면 로컬 mismatch 신호가 done이 되고 다음 cycle ON CONFLICT가 status를 보존 → 실제 Notion을 안 고쳐도 신호가 안 돌아온다. accept="사람이 처리 약속"으로 해석. 실제 Notion write 경로(NotionWriter.update_page + `confirmed`)는 Phase 10+ NotionWriter 작업 시 함께 검토.
- **CI triage 입력은 PR diff만:** 실 CI 로그/실패 체크명은 octocrab 신규 surface라 미도입(가장 작은 변경). 실 codex 출력 관찰 후 입력 보강(실패 잡 로그/체크명) 여지.
- **triage 캡은 status 무관 전체 카운트(reviewer MINOR, 문서화):** 인프라 실패 잡도 캡 슬롯 소모(fail-toward-human 의도). '성공만 카운트'가 필요해지면 status 필터 추후.

### Phase 8 미해결/관찰 항목 (Phase 9+에서 고려)

- **실 codex 실행 미관찰(헤드리스 한계):** gated finalize·proposal 파싱·accept/reject는 cargo test로 검증했으나, 실제 `codex exec`로 PR diff를 읽어 형식 JSON을 내는지·worktree 생성/정리·cost/turns는 사용자가 `pnpm tauri dev`+로그인 codex+GitHub 토큰 보유 프로젝트에서 확인(PR Radar 카드 'self-check 초안' → Jobs awaiting_approval → accept).
- **codex 출력 형식 의존:** proposal은 codex가 프롬프트대로 JSON 객체를 *마지막 메시지*로 내야 파싱된다. 형식 밖이면 `pr_proposal`이 Err로 raw를 노출하고 accept를 막는다(reject만). 실 codex 출력 관찰 후 프롬프트/파싱 정밀화 여지(스키마-관용 현 상태).
- **worktree HEAD vs PR base 불일치:** diff는 GitHub(authoritative)지만 codex worktree는 로컬 repo HEAD detach라 base가 PR과 다를 수 있다. self-check 초안엔 허용(레포 컨텍스트용). 정밀 base 체크아웃은 추후.
- **self-check 잡은 local_path 필수:** worktree 격리(INVARIANT #6) 때문에 PR repo에 local_path가 있어야 트리거됨(없으면 Err). remote-only repo 지원은 추후(scratch 디렉터리 격리 검토).

### Phase 7 미해결/관찰 항목 (Phase 8+에서 고려)

- **실 codex 실행 미관찰(헤드리스 한계):** EchoRunner 라이프사이클·bound·kill·로그는 cargo test로 검증했으나, 실제 `codex exec` 호출·JSONL 스키마·worktree 생성/정리·cost/turns 집계는 사용자가 `pnpm tauri dev` + 로그인된 codex로 확인(Phase 2~6 실네트워크와 동일). 헤드리스에서 codex 호출은 quota/네트워크라 cargo test 제외.
- **`parse_codex_event`는 스키마-관용(best-effort):** 실 codex 0.125 JSONL 이벤트 스키마 확정 전이라 cost/turn 키를 방어적 탐색. cost 이벤트 누락 시 그 줄에선 cap 미트립이나 다음 누적 cost·wall-clock timeout이 hard bound. **실 스키마 관찰 후 정밀화** (사용자 관찰 항목).
- **worktree 정리 = 동기 Drop(best-effort):** 제안 레일 코드 잡은 `WorktreeGuard` Drop이 동기 `git worktree remove`. 동시성 1·실패 무해(orphan은 다음 실행 prune)라 Phase 7 허용. **Phase 10(workspace_write)에서 `spawn_blocking`/명시 async 정리로 승격 검토.**
- **echo 잡 engine=codex 기록:** agent_runs.engine CHECK에 echo 값이 없어 codex 스파인 테스트 하네스로서 engine=codex/kind=echo. per-engine 필터가 필요해지면 Engine 변형 추가 검토.
- **Acceptance/proposal 후속:** Phase 7은 잡 인프라까지. codex 출력→Proposal 표시→사람 accept→로컬 반영은 **Phase 8**(suggestion 레일 첫 자동화). `acceptances` 테이블은 Phase 8에서 첫 사용.

## 먼저 읽을 정본

1. `PLAN.md` — §1 INVARIANTS(절대규칙 7개) + **Phase 10** Deliverables/Done-criteria
2. `docs/architecture.md` — §2 3-Rail, §4 data model(`AgentRun`·`Acceptance`·`Worktree`), §5 AgentRunner, §8 Worktree & Branch Diff(Phase 5 — 실행 레일 diff 검수에 재사용)
3. `docs/decisions.md` — Phase 9(enrich/triage/mismatch 초안)·Phase 8(PR self-check 초안)·Phase 7(Agent 스파인)·Phase 5(worktree diff viewer) 결정
4. `.claude/skills/{codex-worktree-runner,octocrab-keyring,sqlx-sqlite,tauri-specta-ipc}` · `DESIGN.md` · `AGENTS.md` · `docs/reference/commands.md`(검증 명령)
5. **Phase 8/9 코드(직접 선례):** `src-tauri/src/commands.rs`(`trigger_pr_selfcheck`/`trigger_ci_triage`/`accept_*` — gated 잡 + Acceptance 패턴) · `agent.rs`(CodexRunner `prepare_cwd` worktree·`WorktreeGuard` keep=Execution이면 보존) · `jobs.rs`(gated finalize). **실행 레일은 sandbox=`WorkspaceWrite` + `rail=Execution`(worktree 보존) + draft PR 생성이 신규.**

## Phase 10 스코프 (한 번에 한 Phase, PLAN.md Phase 10 done-criteria만)

PLAN.md Phase 10 핵심 — **실행 레일(사람→Codex, 최고 위험·마지막 자동화):**
- 승격된 백로그 1건을 **"지금 실행"만** 트리거(자동 실행 금지), 동시 1, **`workspace-write` 샌드박스**(danger-full 절대 금지), full bounds(timeout/turns/cost cap/kill).
- Codex가 **격리 worktree**(Phase 7 인프라, `rail=Execution`이라 Drop이 보존)에서 구현 → diff 생성.
- push 전 **Phase 5 Worktree Diff Viewer로 사람이 diff 검수** → 검수 후에만 **draft PR 생성**(octocrab). 사람 검수 없이 push 금지.

**Done-criteria(요약):** 백로그 1건 → worktree 브랜치 + draft PR / 생성 worktree diff가 Diff Viewer에 표시 / 사용자 워킹트리 무손상 / kill·cost cap 동작 / 사람 검수 없이 push 안 됨.

**설계 선결 과제(시작 전 결정 권장 — AskUserQuestion):** workspace-write 잡 트리거 위치(승격 백로그 카드 vs 전용 뷰)·draft PR 생성 경로(octocrab create-PR + 브랜치 push 게이트)·worktree 보존/정리 정책(`keep=true` 후 수동 정리)·Phase 7 동기 Drop 정리를 `spawn_blocking`/async로 승격할지(Phase 7 미해결 항목).

## 운영 노트 (환경 함정)

- **Rust 툴체인:** cargo는 `$HOME/.cargo/bin`에 있으나 **기본 PATH에 없음**. cargo/`git commit`(husky pre-commit가 `cargo fmt --check`+`pnpm typecheck`) 전 매번 `export PATH="$HOME/.cargo/bin:$PATH"`. cargo는 `--manifest-path src-tauri/Cargo.toml`로.
- **rtk 훅 주의:** `cargo clippy ... -- -D warnings`·`tail`·`cat`을 rtk가 망가뜨려 **exit 0으로 가리거나** 가짜 요약을 낸다 → `rtk proxy <cmd> > /tmp/x.log 2>&1` 후 **Read 도구**로 raw 로그의 `Finished`/`test result`/경고 0 확인.
- **bindings.ts:** `cargo test`의 export 테스트가 생성. 수기 IPC 타입 금지(specta). **specta는 i64/u64 export 금지** → 작은 정수는 `i32`/`u32`(timeout/turns/tokens). **f64(비-Option)는 `number | null`로 export됨**(NaN 대비) → 프런트에서 `?? 0` 가드(JobsView costCapUsd 선례).
- **codex CLI:** 실 설치본 0.125.0 검증 완료(`exec`/`--json`/`--sandbox read-only`/`-C`(=`--cd`)/`--color never`/`--skip-git-repo-check`/`--` prompt). 감지=PATH+homebrew/usr-local 폴백, 인증=`codex login status`. GUI 앱 launchd PATH가 셸과 달라 폴백 필요.
- **GUI/실네트워크/실 git/실 codex 검증:** 실제 창·핫키·keychain 영속·Notion/GitHub/codex 실호출·실 git 셸아웃은 **사용자 관찰 항목**. 헤드리스에선 `cargo build/test/clippy` + `pnpm typecheck/build` + 필요시 `pnpm tauri dev` 부팅 로그. 실 keychain/network/git/codex는 cargo test에 넣지 말 것.
- **CI(.github/workflows/ci.yml):** rust(fmt/clippy/test) + frontend(typecheck/build)만. (decisions.md가 언급한 scripts/check-*.sh 가드는 현재 레포에 없음.)

## Git 워크플로우 (중요)

- **항상 `dev`에서 작업/커밋/push.** `main`은 PR(dev → main)로만 머지. `git push origin main`은 `.husky/pre-push`가 차단.
- 커밋 = Conventional Commits. 이슈 번호는 PR에만(커밋 메시지 금지). 한 PR = 한 관심사.
- gh 활성 계정이 가끔 `yanghapark`로 바뀜 → `gh auth switch --user 64etuor`로 고정.
- 레포: `64etuor/work-radar` (Private).

## 시작 명령(새 세션에 붙여넣기)

```
work-radar Phase 10 (실행 레일: 승격 백로그 → Codex 격리 worktree 구현 → 사람 diff 검수 → draft PR) 구현.
docs/HANDOFF.md → PLAN.md(§1 INVARIANTS + Phase 10) → docs/architecture.md(§2 3-Rail, §5 AgentRunner, §8 Worktree Diff)
→ docs/decisions.md(Phase 9 suggestion 자동화, Phase 8 PR self-check, Phase 7 Agent 스파인, Phase 5 diff viewer) → src-tauri/src/{commands.rs(trigger_ci_triage/accept_* 패턴),agent.rs(prepare_cwd/WorktreeGuard),jobs.rs(gated finalize)} 순으로 읽고 따른다. 한 번에 한 Phase, Phase 10 done-criteria로 자가검증.
INVARIANTS 준수(특히 #2 Acceptance 게이트=사람 검수 없이 push 금지, #5 full bounds+kill, #6 worktree 격리·workspace-write·danger-full 금지). 작업/푸시는 dev에만.
시작 전 workspace-write 트리거 위치 + draft PR 생성 경로 + worktree 보존/정리 정책만 확인(AskUserQuestion)하고 진행.
```
