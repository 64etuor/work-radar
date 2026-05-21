# Work Radar — 세션 핸드오프 (현재: Phase 8 시작 직전)

> 새 세션은 **이 파일 + 아래 정본들**을 먼저 읽고 시작한다. 이전 대화 컨텍스트 없이도 진행 가능하도록 작성됨.

## 지금 상태

- **Phase 0~7 완료·검증됨.** 레포 `64etuor/work-radar`(Private), `dev`.
  - Phase 1 `6fecaff` · Phase 2 `d57f300` · Phase 3 `2e9f293` · Phase 4 `78ce36b` · Phase 5 `aed1b72` · Phase 6 `0276259` · Phase 7 = 이 세션(아직 커밋 전이면 dev에 커밋 필요).
- **Phase 7 산출물(Agent 스파인 — Codex 기능 전 뼈대; 구현·검증됨):**
  - **`agent.rs`(신설):** `AgentRunner` 트레잇(RPITIT, GitProvider 패턴) + `EchoRunner`(codex 없이 bound/kill/로그 검증용 셸아웃 — 고정 스크립트+위치인자, 인젝션 없음) + `CodexRunner`(`codex exec --json --sandbox read-only --color never -C <cwd> --skip-git-repo-check -- <prompt>`) + `Bounds`/`AgentError`/`AgentOutcome` + 순수 `parse_codex_event`/`BoundsTracker`(max_turns·cost_cap 트립) + codex 감지(`resolve_codex_bin`/`codex_availability`).
  - **`jobs.rs`(신설):** `JobManager`(managed state) — tokio `Semaphore(1)` 동시성 + `Mutex<HashMap<run_id, CancellationToken>>` kill 레지스트리 + codex_bin/worktree_root/logs_dir. `spawn`(INSERT proposed → permit → running → `tokio::select!`(run, sleep(timeout), cancel) → succeeded/failed/cancelled 영속 + 로그) + `kill`(큐 대기 중에도 가능). agent_runs INSERT/UPDATE/fetch/log-tail 헬퍼.
  - **`models.rs`:** `Engine`/`AgentRail`/`Sandbox`(read_only|workspace_write — **danger_full 없음**)/`AgentStatus` enum + `AgentRunView`(i64 record→u32/f64 변환) + `CodexAvailability` + `TriggerEchoInput`/`TriggerCodexInput`.
  - **`commands.rs`:** `codex_status` · `trigger_echo_job` · `trigger_codex_job`(미설치/미인증 시 Err) · `list_agent_runs` · `kill_agent_run` · `read_agent_log`. **`lib.rs`** 6커맨드 등록 + `JobManager` manage(setup에서 codex 경로 해석). bindings 재생성. **`Cargo.toml`** `tokio-util`(CancellationToken) 추가.
  - **프런트:** `query.ts` `useCodexStatus`/`useAgentRuns`(active면 2s 폴링)/`useTriggerEchoJob`/`useTriggerCodexJob`/`useKillAgentRun`/`useAgentLog` + `JOBS_POLL_MS`. `store.ts` View+=`jobs`. `App.tsx` 6-way 렌더+Esc. `CommandPalette` "Jobs (Agent)로". `JobsView`(codex 가용성 배너로 graceful degrade · 테스트 잡 버튼 echo/timeout · codex 프롬프트 폼 · 잡 카드 상태배지/bounds/cost · kill · 로그 패널). `styles.css` `.jobs-*`(.pr-* 토큰 재사용).
  - **사용자 결정(AskUserQuestion):** 잡 큐=agent_runs 영속 / 동시=1 / echo 검증=EchoRunner+Jobs 버튼. 상세 `docs/decisions.md` Phase 7.
  - **검증:** `cargo test` **74 passed**(agent 4 + jobs 3 신규) · `cargo clippy -D warnings` clean · `pnpm typecheck`/`build` green · `cargo fmt` 적용 · INVARIANTS reviewer(critic) **7개 PASS / done-criteria 3개 PASS, BLOCKER·MAJOR 0**(reviewer 트레이드오프: 동기 Drop worktree 정리·best-effort cost cap은 decisions.md에 문서화).
- **다음 = Phase 8 (첫 자동화: PR self-check 자동 초안 — suggestion 레일)** — `dev` 브랜치에서.

### Phase 7 미해결/관찰 항목 (Phase 8+에서 고려)

- **실 codex 실행 미관찰(헤드리스 한계):** EchoRunner 라이프사이클·bound·kill·로그는 cargo test로 검증했으나, 실제 `codex exec` 호출·JSONL 스키마·worktree 생성/정리·cost/turns 집계는 사용자가 `pnpm tauri dev` + 로그인된 codex로 확인(Phase 2~6 실네트워크와 동일). 헤드리스에서 codex 호출은 quota/네트워크라 cargo test 제외.
- **`parse_codex_event`는 스키마-관용(best-effort):** 실 codex 0.125 JSONL 이벤트 스키마 확정 전이라 cost/turn 키를 방어적 탐색. cost 이벤트 누락 시 그 줄에선 cap 미트립이나 다음 누적 cost·wall-clock timeout이 hard bound. **실 스키마 관찰 후 정밀화** (사용자 관찰 항목).
- **worktree 정리 = 동기 Drop(best-effort):** 제안 레일 코드 잡은 `WorktreeGuard` Drop이 동기 `git worktree remove`. 동시성 1·실패 무해(orphan은 다음 실행 prune)라 Phase 7 허용. **Phase 10(workspace_write)에서 `spawn_blocking`/명시 async 정리로 승격 검토.**
- **echo 잡 engine=codex 기록:** agent_runs.engine CHECK에 echo 값이 없어 codex 스파인 테스트 하네스로서 engine=codex/kind=echo. per-engine 필터가 필요해지면 Engine 변형 추가 검토.
- **Acceptance/proposal 후속:** Phase 7은 잡 인프라까지. codex 출력→Proposal 표시→사람 accept→로컬 반영은 **Phase 8**(suggestion 레일 첫 자동화). `acceptances` 테이블은 Phase 8에서 첫 사용.

## 먼저 읽을 정본

1. `PLAN.md` — §1 INVARIANTS(절대규칙 7개) + **Phase 8** Deliverables/Done-criteria
2. `docs/architecture.md` — §2 3-Rail(제안 레일=Codex→Proposal→Acceptance), §4 data model(`AgentRun`·`Acceptance`·`WorkSignal.links`), §5 AgentRunner, §8 Worktree/Diff(검수)
3. `docs/decisions.md` — Phase 7(Agent 스파인)·Phase 4(PR Radar, octocrab)·Phase 5(worktree diff) 결정
4. `.claude/skills/{codex-worktree-runner,octocrab-keyring,sqlx-sqlite,tauri-specta-ipc}` · `DESIGN.md` · `AGENTS.md` · `docs/reference/commands.md`(검증 명령)
5. **Phase 7 코드(직접 선례):** `src-tauri/src/agent.rs`(CodexRunner — Phase 8이 확장) · `src-tauri/src/jobs.rs`(JobManager) · `src-tauri/src/github.rs`(PR diff fetch 후보)

## Phase 8 스코프 (한 번에 한 Phase, PLAN.md Phase 8 done-criteria만)

PLAN.md Phase 8 핵심 — **첫 자동화: PR self-check 자동 초안(suggestion 레일):**
- `CodexRunner`가 PR diff를 읽고 **self-check / 설명 / 스크린샷 필요 / 마이그레이션 노트**를 `Proposal`(draft)로 생성.
- 사람이 **accept** → 로컬 self-check 체크리스트/PR 설명 초안을 채움(제출은 수동). = **Acceptance 게이트**(INVARIANT #2).

**Done-criteria(요약):** 실제 PR에 잡 실행 → Proposal 표시 / accept 전 GitHub 무변경(Acceptance 검증) / worktree 격리·잡 종료 후 정리.

**설계 선결 과제(시작 전 결정 권장 — AskUserQuestion):**
- **Proposal 산출 형식:** codex에 어떤 프롬프트로 PR diff를 넘기고(Phase 5 diff 텍스트 재사용 vs github fetch), 어떤 구조(self-check 항목/설명/스크린샷/마이그레이션)로 받을지. `--output-schema`(codex가 JSON Schema 지원) 사용 여부.
- **Acceptance 흐름:** `agent_runs.status` `proposed→awaiting_approval→succeeded` + `acceptances`(append-only, agent_run_id FK) 첫 사용. accept 시 `WorkSignal.links`/로컬 체크리스트(`pr_self_checks`?) 반영 위치.
- **트리거 진입점:** PR Radar 카드의 "self-check 초안" 액션 vs Jobs 뷰. 잡↔PR 연결(`agent_runs.trigger` JSON `{prUrl}`).
- **INVARIANT #2/#6:** accept 전 GitHub 절대 무변경(제출은 사람 수동), worktree 격리+종료 정리.

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
work-radar Phase 8 (첫 자동화: PR self-check 자동 초안 — suggestion 레일) 구현.
docs/HANDOFF.md → PLAN.md(§1 INVARIANTS + Phase 8) → docs/architecture.md(§2 3-Rail, §4 AgentRun/Acceptance, §5 AgentRunner)
→ docs/decisions.md(Phase 7) → src-tauri/src/{agent,jobs}.rs(직접 선례) 순으로 읽고 따른다. 한 번에 한 Phase, Phase 8 done-criteria로 자가검증.
INVARIANTS 준수(특히 #2 accept 전 GitHub 무변경=Acceptance 게이트, #6 worktree 격리+정리, #1 결정 레일 침범 금지). 작업/푸시는 dev에만.
시작 전 Proposal 산출 형식(codex 프롬프트/스키마) + Acceptance 흐름(acceptances 첫 사용) + 트리거 진입점만 확인하고 진행.
```
