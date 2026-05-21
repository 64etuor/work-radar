# Work Radar — Phased Plan (Ralph-ready)

이 문서는 Ralph가 단계별로 소비하는 마스터 플랜이다. 각 Phase는
**Goal → Deliverables → Done-criteria** 를 가진다. Ralph는 done-criteria가
모두 green이면 다음 Phase로 넘어가고, 실패하면 그 Phase에 머문다.

순서를 건너뛰지 말 것. Phase 0→11 의존 순서를 지킨다.

---

## 0. Product one-liner

흩어진 업무 신호를 아이젠하워 매트릭스로 모으고, 사람이 직접 Notion 백로그·안건·
일정·실행 작업으로 수동 승격하는 개인/팀 업무 관제 앱. 자동화(Codex)는 제안/실행
레일에만 붙고 결정은 항상 사람이 한다.

---

## 1. INVARIANTS — Ralph가 절대 위반하면 안 되는 것

이 7개는 모든 Phase에서 강제된다. 위반하는 구현은 done이 아니다.

1. **결정 레일은 사람만.** Codex/규칙은 매트릭스 분류·승격 여부를 자동 확정하지 못한다.
   suggested quadrant는 *힌트*일 뿐, 카드는 항상 `unclassified`로 진입한다.
2. **모든 외부 변경은 Acceptance 게이트를 거친다.** Codex 출력이 Notion/GitHub를
   직접 mutate하지 못한다. 사람이 accept해야 변경된다.
3. **신호는 upsert(dedup), append 아님.** system/PR/Hermes 신호는 안정적 dedup 키로
   중복 생성을 막고, 원인이 해소되면 auto-resolve 한다. (예: CI 통과 시 신호 소멸)
4. **매트릭스는 거울이 아니라 결정 큐.** ambient status(PR Radar/Hermes)는 자기 뷰에
   살고, **임계치를 넘을 때만** 매트릭스로 escalate 한다.
5. **모든 에이전트 잡은 bound된다.** timeout + max turns + cost cap + kill switch.
   재트리거 체인(CI triage 등)에도 횟수 캡을 두고 초과 시 사람에게 escalate(Q1).
6. **코드 작업은 git worktree에 격리.** 사용자 워킹트리를 절대 건드리지 않는다.
   샌드박스 기본 read-only, 쓰기는 명시 승인 시 workspace-write, danger-full 금지.
7. **SSOT 분리.** Notion = 백로그/안건 *내용*의 SSOT. 로컬 SQLite = 매트릭스 상태·
   신호·승격 이력·에이전트 잡의 SSOT. 로컬 미러는 read cache + write-through일 뿐.

추가 규칙:
- **Next.js 쓰지 말 것.** desktop webview엔 Vite + React. (`docs/architecture.md` 참조)
- **Notion/GitHub 호출은 Rust에 둔다.** 토큰을 렌더러에 노출하지 않는다.
- **토큰은 OS keychain.** SQLite 평문/프런트 저장 금지. project별 분리.
- **bounded retry only.** 무한 retry/poll 금지. backoff + jitter + terminal failure 노출.
- **디자인 정본 = `DESIGN.md`(Cohere white editorial).** 캡처 보드 인터랙션 레퍼런스 =
  `docs/prototypes/capture-board.html`. 이전 Raycast 다크 방향은 `docs/archive/design-raycast.md`(폐기).

---

## 2. Stack (확정)

- Tauri 2.x / Rust(tokio, sqlx+SQLite, reqwest, octocrab, keyring) / specta
- Vite + React + TS + Tailwind + shadcn/ui + cmdk + TanStack Query + Zustand
- 자동화: Codex CLI `codex exec --json` via tokio::process, worktree 격리

---

## 3. Phases

### Phase 0 — 스켈레톤 & 스파인
**Goal:** 빈 앱이 부팅되고, Rust↔TS 타입 계약과 DB 마이그레이션 스파인이 선다.
**Deliverables:**
- Tauri 2 + Vite + React + TS + Tailwind + shadcn/ui + cmdk 부트스트랩
- Rust: tokio · sqlx(SQLite) + migrations · tauri-specta · keyring 래퍼
- SQLite 스키마 v1: `projects, repos, signals, promotions, agent_runs, acceptances` + FTS5
- 전역 핫키로 캡처창 토글 (tauri-plugin-global-shortcut)
- AGENTS.md의 불변식을 코드 주석/모듈 경계에 반영
**Done-criteria:**
- [ ] `pnpm tauri dev` 부팅, 빈 창 렌더
- [ ] 빈 DB가 마이그레이션 적용됨 (테이블 6개 + FTS 존재)
- [ ] specta가 Rust 타입을 TS로 생성, 프런트가 import
- [ ] `list_projects` command 라운드트립 성공 (빈 배열 반환)
- [ ] 전역 핫키로 캡처창 show/hide

### Phase 1 — Capture Board (THESIS): 촤라락 포스트잇 + 아이젠하워 오버레이
**Goal:** 캡처→분류→액션의 핵심 루프가 **공간형 포스트잇 보드**로 끈끈하게 동작 (Notion 없이).
디자인 정본: `DESIGN.md`(Cohere white editorial). 인터랙션 레퍼런스: `docs/prototypes/capture-board.html`.

**Deliverables:**
- **캡처 보드 = 앱 창(현행 decorationless 단일 창, 불투명 white canvas)**이 곧 보드. 전역 핫키로 토글, Esc로 닫힘. (Tauri 투명 데스크톱 오버레이는 **폐기** — 클릭스루/멀티모니터 리스크.)
- **조작 패널**(floating box): braindump 입력 + **개인/업무 세그먼트 토글(기본 업무)** + 통계/Work Debt.
- **태그 컨벤션:** 입력 맨 앞 토큰이 마커면 우선(개인: `개인/내/나/사적`, 업무: `업무/일/회사/직장`),
  없으면 토글값(기본 **업무**). 맨 앞 토큰 정확매칭으로 오탐 방지(예: "내일"은 "내"로 오인 안 됨).
  → `WorkSignal.kind`(personal/work) 힌트로 저장하고 Phase 2에서 `projectId`로 reconcile.
- **촤라락:** 보드 진입 시 미분류 `WorkSignal`들이 staggered spring으로 펼쳐짐. 입력 시 새 카드가 톡(pop)으로 미분류에 붙음.
- **분류 = 사람 결정 레일(INVARIANT #1):** 카드를 사분면으로 **드래그**(주) 또는 포커스 후 `1/2/3/4`(가속).
  카드는 **항상 `unclassified`로 생성**, 자동 분류 없음. 사분면 내 자동정렬(pack), 미분류는 카스케이드(가로)/그리드(세로).
  사분면에 들어간 카드는 그 **사분면 값을 태그(Q1~Q4 배지)로 지님** — Today로 옮겨가도 유지(원 우선순위 표시).
- **카드 액션 메뉴**(⋯ 버튼 / `Cmd+K` / 우클릭): 백로그 등록·안건 승격·캘린더 등록은 **`Promotion` draft만**
  생성(=**Acceptance 게이트**, 실제 외부 write는 Phase 3/11) + **Today 추가** + 미루기/완료/보관(`S/D/E`).
- **Today's Todo 레일(우측 고정·기본 표시):** 오늘 집중할 항목 큐레이션 리스트. 매트릭스 카드를 우측 레일로
  **드래그** 또는 카드 액션 **"Today 추가"**로 승격. Today 승격은 **로컬(SQLite) 액션** — 사람이 결정,
  외부 write 아님 → **Acceptance 불요**(notion_*/calendar 승격과 구분). 승격하면 카드는 **매트릭스(아이젠하워)에서
  빠지고 Today 레일에만 표시**(분류돼 있었으면 Q1~Q4 배지 유지). 각 항목 **완료 체크박스** + 재정렬,
  **미완료 항목은 다음날로 자동 이월(rollover)·완료는 이월 안 함**, **날짜 스코프(오늘)**. (전체 Today 운영 뷰는 Phase 11.)
- **반응형:** 세로 모니터=미분류 상단 트레이 / 가로 모니터=좌측 레일 + 우측 Today 레일.
  세로에선 Today를 하단 시트/접기로.
- `WorkSignal` CRUD + dedup 키, FTS5 전역 검색. (스키마에 `area`/`suggestedArea` 필드 포함 —
  데이터만; **AI 영역 추론과 칩 표시는 Phase 9 enrich**.)

**Done-criteria:**
- [ ] 전역 핫키로 보드 창 토글(show/hide), Esc로 닫힘
- [ ] 한 줄 입력 → 미분류 카드 톡 생성, 태그 규칙대로 개인/업무 부여(마커 > 토글, 기본 업무)
- [ ] 진입 시 기존 미분류 카드가 촤라락(staggered)으로 펼쳐짐
- [ ] 드래그로 사분면 분류 + `1/2/3/4` 가속, 카드는 항상 unclassified로 진입(자동분류 0건)
- [ ] 카드 액션 메뉴: 백로그/안건/캘린더는 **Promotion draft만**(외부 무변경·Acceptance 대기), snooze/done/archive 동작
- [ ] 우측 Today's Todo 레일 기본 표시; Today 승격 시 카드가 **매트릭스에서 사라지고** Today에만 표시(분류돼 있었으면 Q1~Q4 배지 유지)
- [ ] Today 항목 완료 체크 + 재정렬; **미완료는 다음날 유지(rollover), 완료는 이월 안 됨**
- [ ] 세로/가로 모니터 레이아웃 정상(상단 트레이 ↔ 좌측 레일 + 우측 Today 레일; 세로는 Today 하단 시트)
- [ ] FTS 검색이 본문/제목 매칭, 앱 재시작 후 상태 유지, 같은 입력이 dedup 키로 합쳐짐

### Phase 2 — Project & 멀티 레포 설정
**Goal:** 개인/업무 프로젝트와 여러 레포를 추가/관리.
**Deliverables:**
- Add Project(`personal`/`work`) / Add Repo(github remote · local path)
- project별 토큰 keychain 저장 + Notion DB(backlog/agenda) 바인딩
- `ticketKeyPattern`(예: `MIR-DEV-\d+`) 설정 — 이후 join key
**Done-criteria:**
- [ ] 개인 1 + 업무 1 프로젝트 생성, repo 목록 표시
- [ ] 토큰이 keychain에 저장됨(평문 DB 아님), 재부팅 후 유지
- [ ] 각 project 토큰으로 테스트 API ping 성공/실패 표시
- [ ] 모든 signal/run이 `projectId` 태깅

### Phase 3 — Notion 승격 (write 레일)
**Goal:** 매트릭스 카드를 Notion 백로그/안건으로 수동 승격.
**Deliverables:**
- Notion read(미러 캐시) + 카드→백로그/안건 write-through + `Promotion` append-only 로그
- rate-limit(3 req/s) 인지 클라이언트 + bounded retry/backoff/jitter + terminal failure 노출
**Done-criteria:**
- [ ] 카드 승격 → 해당 project Notion DB에 페이지 생성
- [ ] Promotion 로그에 기록(undo 가능 데이터)
- [ ] 오프라인 시 승격이 큐잉되고 복구 시 flush
- [ ] rate limit 초과해도 무한 retry 없이 backoff 후 실패 노출

### Phase 4 — GitHub PR Radar (read 레일)
**Goal:** 멀티 레포 PR을 readiness 버킷으로, 임계치 넘는 것만 매트릭스로.
**Deliverables:**
- project별 octocrab, open/my PR across repos
- 도출: CI 상태·conflict·draft·age·linked-backlog(ticketKeyPattern 조인)
- readiness 버킷(Needs Self Check / CI Blocked / Ready / Merged Cleanup / Stale) + 수동 self-check(로컬 상태)
- PR 신호는 임계치 넘을 때만 매트릭스 escalate, dedup 키 사용
**Done-criteria:**
- [ ] 두 프로젝트 PR이 버킷별 표시
- [ ] `CI failed + 오늘 마감 백로그 링크` → Q1에 1건
- [ ] 폴링 N회 반복해도 동일 PR 신호 중복 0
- [ ] CI 통과로 바뀌면 해당 신호 auto-resolve

### Phase 5 — Worktree & Branch Diff Viewer
**Goal:** 레포별 git worktree/브랜치를 나열하고, worktree·브랜치별 diff를 본다.
**Deliverables:**
- repo별 `git worktree list` + 브랜치 목록 (Rust: git2 또는 git CLI 셸아웃)
- `Worktree` 모델: path · branch · head · baseBranch · ahead/behind · dirty 상태
- Diff 뷰 비교 모드 4종: `working`(미커밋) / `staged` / `vs_base`(예: origin/dev) / `branch↔branch`
- 파일 목록(+adds/-dels, status M/A/D/R) + 파일별 diff(구문 강조)
- PR Radar 및 실행 레일과 연결: PR 브랜치·Codex worktree의 diff를 같은 뷰로 검수
**Done-criteria:**
- [ ] 한 repo의 모든 worktree가 상태 배지(ahead/behind/dirty)와 함께 표시
- [ ] worktree 선택 → 파일 목록 + 파일별 diff 렌더
- [ ] 비교 모드 4종(working/staged/vs_base/branch↔branch) 동작
- [ ] 멀티 repo(개인+업무) worktree 동시 표시 + projectId 필터
- [ ] 대용량 diff에서 UI 비차단(지연/가상 로드)

### Phase 6 — status mismatch 감지 (차별점)
**Goal:** Notion↔PR drift를 잡는다.
**Deliverables:**
- 티켓별 마지막 PR/Notion 스냅샷 저장 → drift 감지 → mismatch 신호(dedup + auto-resolve)
**Done-criteria:**
- [ ] "Notion Doing + PR Merged" 시뮬 → mismatch 정확히 1건
- [ ] Notion 갱신 시 mismatch auto-resolve
- [ ] join key 매칭 실패 케이스가 noise를 만들지 않음(매칭 안 되면 신호 없음)

### Phase 7 — Agent 스파인 (Codex 기능 전, 뼈대만)
**Goal:** 안전한 에이전트 실행 인프라.
**Deliverables:**
- `AgentRun` 모델 + 잡 큐(동시 1~2) + bounds(timeout/turns/cost cap) + kill switch + Jobs 뷰
- `AgentRunner` trait + `CodexRunner`(=`codex exec --json`, read-only 샌드박스, worktree)
- codex 미설치/미인증 시 graceful degrade (앱 핵심 100% 동작)
**Done-criteria:**
- [ ] echo 잡이 bound 내 실행, Jobs 뷰 표시, kill 동작, 로그 캡처
- [ ] timeout/cost cap 초과 시 kill + `failed`
- [ ] codex 없을 때 자동화 UI는 비활성, 나머지 정상

### Phase 8 — 첫 자동화: PR self-check 자동 초안 (suggestion 레일)
**Goal:** diff를 읽고 self-check 초안을 Proposal로.
**Deliverables:**
- `CodexRunner`가 PR diff 읽고 self-check/설명/스크린샷필요/마이그레이션노트를 Proposal로
- 사람 accept → 로컬 체크리스트/PR 설명 초안 채움 (제출은 수동)
**Done-criteria:**
- [ ] 실제 PR에 실행 → Proposal 표시
- [ ] accept 전 GitHub 무변경 (Acceptance 게이트 검증)
- [ ] worktree 격리, 잡 종료 후 정리

### Phase 9 — 추가 suggestion 자동화
**Goal:** enrich / CI triage / mismatch 초안.
**Deliverables:**
- braindump enrich(#2): `suggestedQuadrant` + **`suggestedArea`(라이프 도메인, 닫힌 taxonomy)** 추론.
  suggested만 — 카드는 unclassified 유지, area는 사람이 확정/수정. AI는 세트 밖 카테고리 생성 금지.
- CI triage(#3): 원인/수정안 Proposal + **재트리거 횟수 캡 + 초과 시 Q1 escalate**
- mismatch 해소 초안(#4): Notion 업데이트 draft
**Done-criteria:**
- [ ] 각 잡이 Acceptance 게이트 뒤 Proposal 생성
- [ ] 동일 CI 실패 재triage가 캡에서 멈추고 Q1으로 escalate
- [ ] enrich가 카드를 자동 분류하지 않음 (quadrant 자동 확정 0)
- [ ] enrich가 `suggestedArea`를 닫힌 세트(health…finances|other)에서만 부여, 사람이 수정 가능

### Phase 10 — 실행 레일 (최고 위험, 마지막)
**Goal:** 승격된 백로그를 Codex가 격리 worktree에서 구현 → draft PR.
**Deliverables:**
- "지금 실행"만 트리거, 동시 1, workspace-write 샌드박스, full bounds
- push 전 **Phase 5 Worktree Diff Viewer로 diff 검수**, draft PR 생성
**Done-criteria:**
- [ ] 백로그 1건 → worktree 브랜치 + draft PR
- [ ] 생성된 worktree diff가 Diff Viewer에 그대로 표시
- [ ] 사용자 워킹트리 무손상 확인
- [ ] kill 가능, cost cap 동작
- [ ] 사람 검수 없이 push 안 됨

### Phase 11 — Today / Timeline / 마감
**Goal:** 하루 운영 뷰 + 부채 지표.
**Deliverables:**
- Today(일정 + Q1 + focus + PR attention + unprocessed count)
- Timeline + Weekly review + Work Debt
**Done-criteria:**
- [ ] Today가 Q1/일정/PR attention/미분류 수를 정확히 집계
- [ ] Work Debt 지표(미분류, Q1 overdue, stale backlog, cleanup needed 등) 표시

---

## 4. How Ralph should use this

- 한 번에 한 Phase. 그 Phase의 done-criteria 체크박스를 검증 가능한 테스트/관찰로 채울 것.
- 매 Phase 종료 시 INVARIANTS 7개 위반 여부를 reviewer로 확인. 위반 시 done 아님.
- done-criteria가 모두 green일 때만 다음 Phase. 실패는 그 Phase에서 반복.
- 새 결정/트레이드오프는 `docs/decisions.md`(없으면 생성)에 한 줄로 남길 것.
