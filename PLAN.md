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
- **보드 레이아웃(5영역):** 흐름 = 캡처(하단) → **미분류(좌)** → **아이젠하워 2×2(중앙)** →
  **실행(우: Today's Todo 위 / Routines 아래)**. 좌=intake · 중앙=decide · 우=execute · 하단=capture.
- **조작 패널**(하단 floating box): braindump 입력 + **개인/업무 세그먼트 토글(기본 업무)** + 통계/Work Debt.
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
  **미완료 항목은 다음날로 자동 이월(rollover)·완료는 이월 안 함**, **날짜 스코프(오늘)**.
  각 항목에 **경과일 카운터 `+N`** — Today로 옮긴 날 `+1`, 미완료로 이월될 때마다 +1 증가(쌓인 부채 가시화), 완료 시 종료.
  **매트릭스로 되돌리기(승격 취소)** 버튼 — 원 사분면(Q1~Q4)으로 복귀(분류 없었으면 미분류), Today에서 제거·카운터 리셋. (전체 Today 운영 뷰는 Phase 11.)
- **Routines(루틴) 영역(우측 하단):** 반복 작업 체크리스트. 스케줄 **매일 / 매주 특정 요일(예: 수·금) / 매주(예: 금)**.
  오늘 해당하는 루틴만 표시, **완료 체크는 날짜별**(다음날 리셋·재등장). 추가 시 제목 + 스케줄(매일/요일 선택) + area/kind 칩.
- **반응형:** 가로=좌 미분류 / 중앙 2×2 / 우(Today 위·Routines 아래). 세로·좁은 화면=세로 스택
  (미분류 트레이 → 2×2 → Today → Routines), 우측 패널은 하단 시트/접기 또는 Today·Routines 세그먼트 탭.
  조작 패널은 하단 고정·폭 `min(640px, 100%-여백)`.
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
- [ ] Today 항목에 경과일 카운터 `+N` 표시 — promote일 +1, 미완료 이월 시 매일 +1 증가, 완료 시 종료
- [ ] Today 항목 "매트릭스로 되돌리기(승격 취소)" → 원 사분면 복귀(없으면 미분류), Today에서 제거
- [ ] Routines: 매일/요일 스케줄 루틴 추가, 오늘 해당 루틴만 표시, 날짜별 완료 체크(다음날 리셋)
- [ ] 5개 영역(미분류·2×2·Today·Routines·캡처) 배치 + 세로/가로 반응형 동작(세로 스택/접기)
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
- PR Radar와 연결: PR 브랜치·(제안 레일 코드 잡 등) worktree의 diff를 같은 뷰로 검수 (실행 레일은 폐기)
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

### Phase 10 — Google Calendar 연동 (read 레일)

> 옛 Phase 10(실행 레일)은 **폐기**됨 — 맨 아래 "폐기된 계획" 부록 참조. 새 Phase 10은
> Today(Phase 11)가 소비할 **캘린더 read 레일**이다.
> **상세 설계·구현 계획(새 세션 진입점) = `docs/specs/phase-10-google-calendar.md`.**

**Goal:** 프로젝트별 Google Calendar OAuth → 다중 캘린더 선택 → 오늘 이벤트 read.
개인/업무 프로젝트가 각자 Google 계정·OAuth 자격증명을 분리해서 가진다(기존 keychain
패턴). PR Radar처럼 ambient(이벤트 영속 없음). Today/Timeline(Phase 11)이 소비.

**스코프 = 2개 PR (Today 표시는 Phase 11):**
- **10a — OAuth 연결:** `TokenKind::GoogleCalendar`(keychain blob: clientId/secret/refreshToken),
  사용자 제공 client(Settings 입력), loopback + PKCE(S256) OAuth(`calendar.readonly`),
  토큰 refresh, connect/disconnect/status 커맨드 + Settings 연결 UI. graceful degrade.
- **10b — 캘린더 선택 + 이벤트:** migration 0006 `projects.google_calendar_ids`, calendarList
  조회 + 다중 선택 저장, `fetch_calendar_events(projectId|null, date)`(선택 캘린더 오늘 이벤트
  시간순 병합·all-day 포함·프로젝트별 부분 실패 격리), `CalendarProvider` 트레잇 + Http 구현,
  Settings 다중 캘린더 picker.

**Deliverables:** 위 2 PR. 자격증명/토큰 keychain·렌더러 미노출, 외부호출 Rust(reqwest),
bounded·graceful degrade(#5), read-only 스코프(외부 mutate 0 → Acceptance 불요),
선택목록 SQLite SSOT(#7), specta i64 금지.

**Done-criteria:**
- [ ] (10a) Settings 프로젝트별 client 입력 → "연결" → 브라우저 동의 → refresh token keychain 저장(재부팅 유지); 미연결/client 미입력 graceful degrade; 토큰 렌더러 미노출
- [ ] (10a) access token 만료 시 refresh로 자동 재발급(bounded, 무한 retry 아님)
- [ ] (10b) 연결 후 calendarList 표시 + 다중 캘린더 선택 저장(개인/업무 계정 분리)
- [ ] (10b) `fetch_calendar_events(date)`가 개인+업무 선택 캘린더 오늘 이벤트를 시간순 병합 반환(all-day 포함)
- [ ] (10b) 미연결/네트워크 실패 프로젝트는 격리(나머지 정상)
- [ ] 파싱·오늘 윈도잉·PKCE(S256)·병합/정렬은 cargo test; 실 OAuth loopback·실 Google fetch·keychain 영속은 사용자 관찰 항목

### Phase 11 — Today / Timeline / Weekly review / 마감(Work Debt)
**Goal:** 하루 운영 뷰 + 부채 지표. (Phase 10 Google Calendar를 "일정"으로 소비.)
**Deliverables:**
- Today(Google Calendar 오늘 이벤트[Phase 10] + Q1 + focus + PR attention + unprocessed count + Today 레일 + 오늘 루틴)
- Timeline(신호/승격/이벤트 시간축) + Weekly review(주간 집계) + Work Debt 지표
**Done-criteria:**
- [ ] Today가 Q1/캘린더 오늘 이벤트/PR attention/미분류 수를 정확히 집계
- [ ] Work Debt 지표(미분류, Q1 overdue, stale backlog, cleanup needed 등) 표시
- [ ] Timeline + Weekly review 동작 (정의는 Phase 11 착수 시 brainstorming으로 확정)

---

## 3b. Phase 12–20 — Dogfooding 정교화 (통합 ralplan)

> 사용자 dogfooding 백로그(~24개)를 brainstorming으로 9 Phase로 분할. **정본 설계·병렬 파견 전략·
> 의존 그래프·INVARIANT 적합성 = `docs/specs/phase-12-20-dogfood-refinement.md`.** 아래는 요약.
> 병렬 파견 wave: **(0) 12a→12b 게이트 → (1) 13·14·15·17·19·12c·12d → (2) 16·20 → (3) 18.**

### Phase 12 — Prep/Cleanup + Git 운영
**Goal:** 병렬 기반(표면 축소+모듈 분리) + worktree/브랜치 운영.
**Deliverables:** (12a) MISMATCH 전체 제거(코드/UI/신호/컬럼 마이그레이션) · (12b) `commands.rs`/`query.ts`
도메인 모듈 분리(행위 무변경) · (12c) worktree live dirty+활성 변경 표시 + 안전 dev rebase(fetch→dirty 거부→
백업 ref→충돌 abort+복구→diff 검수) · (12d) merged/stale 브랜치·워크트리 정리(다중선택·확인·current/dirty 보호).
**Done-criteria:**
- [ ] mismatch 코드 0(grep), 신호+컬럼 마이그레이션 제거, test/clippy/typecheck/build green
- [ ] commands/query 모듈 분리, 커맨드 등록·bindings 동일
- [ ] worktree live dirty 자동 갱신 + 활성 변경 표시
- [ ] 안전 dev rebase(가드 5단계), 브랜치/워크트리 정리(보호 가드)

### Phase 13 — 트레이 상주 스파인 + 알림 + 스케줄러 (foundational)
**Goal:** 메뉴바 상주 + 알림 + bounded 백그라운드 스케줄러(16·20 소비).
**Deliverables:** tray icon/menu(show/hide/quit), 닫기=트레이 hide, `tauri-plugin-notification`+권한,
`Scheduler` managed state(bounded tick·등록형 due-check·다음 발사 SQLite 영속).
**Done-criteria:**
- [ ] 트레이 상주, 창 닫아도 백그라운드 유지, 트레이 show/hide/quit
- [ ] 알림 권한 + 테스트 알림(사용자 관찰)
- [ ] 스케줄러 bounded tick(busy-loop 아님), 등록 due-check 호출, 재부팅 후 복구

### Phase 14 — 온보딩 & Auth
**Goal:** 토큰 어포던스 통일(CLI import) + 키체인 프롬프트 + 폴더 picker.
**Deliverables:** (8) 안정 코드서명으로 keychain 매번-프롬프트 제거 · (9) `tauri-plugin-dialog` 폴더 picker
(붙여넣기 제거) · (18/19) `gh auth token`/ntn 토큰 import→keychain, 미로그인 시 앱 버튼 `gh auth login --web`,
paste는 fallback.
**Done-criteria:**
- [ ] 안정 서명 → keychain 암호 프롬프트 안 뜸(리빌드 후, 사용자 관찰)
- [ ] repo local_path 폴더 picker, 경로 입력 통일
- [ ] GitHub/Notion 토큰 CLI import(불가 시 paste fallback), 토큰 keychain만·평문 0

### Phase 15 — Capture / Inbox UX
**Goal:** 미분류 전체 일괄 enrich + 브레인덤프 편집/삭제.
**Deliverables:** (4) `trigger_enrich_all` 단일 codex 배치 잡(suggested-only, 부분 실패 격리, Acceptance 게이트) +
"전체 제안 실행" 버튼 · (5) `update_signal_title`(dedup 갱신)+`delete_signal`(하드, archive와 구분).
**Done-criteria:**
- [ ] "전체 제안 실행" 1버튼=단일 배치 잡(bounded), 결과 suggested 표시(자동 분류 0)
- [ ] 브레인덤프 편집+하드 삭제, accept 전 외부 무변경

### Phase 16 — Routines 강화
**Goal:** 격주/월간 + 드래그 정렬 + 시간/알림 + 트래킹. **Depends:** 13(알림), 공용 dnd.
**Deliverables:** (1) `RoutineFreq`+=Biweekly/Monthly+`anchor_date`(월간=같은 날짜·월말 클램프, 격주=앵커 2주) ·
(2) `routines.rank`+`reorder_routines`(드래그) · (6) `time_of_day?`/`reminder_offset_min?`+스케줄러 알림 ·
(12) 루틴 트래킹 뷰(이행률/streak/히스토리).
**Done-criteria:**
- [ ] 격주·월간 스케줄, 오늘 해당만 표시
- [ ] 드래그 정렬(rank), 시간+알림(트레이 상주 발송), 트래킹 차트

### Phase 17 — Today / Todo & 회고
**Goal:** Today 드래그 + 전용 회고 뷰 + 보관함. **Depends:** 공용 dnd.
**Deliverables:** (3) TodayRail 드래그(±1 버튼 제거) · (13) `view:"retro"` 기간 피커+완료 todo 타임라인+
impact/regret 태깅(`signals.impact_high`/`regret` 마이그레이션)+랭킹 · (14) 보관함 뷰(archived+snoozed 열람+복원).
**Done-criteria:**
- [ ] Today 드래그 정렬
- [ ] 회고 뷰(타임라인+impact/regret+랭킹), 보관함(열람+복원), 모든 액션 로컬·자동 분류 0

### Phase 18 — Navigation & UI/UX 폴리시 (fleet 마지막)
**Goal:** 단축키/창키/전환/중복 제거 + UI/UX 밸런스 audit.
**Deliverables:** (7) Settings keymap(view→shortcut)+글로벌 창 핫키 변경(재등록)+전환 효과+중복 뷰/기능 정리 ·
(24) DESIGN.md 기준 audit→punch-list 수정(`/design-review` 권장).
**Done-criteria:**
- [ ] 메뉴별 단축키 편집·창 핫키 변경, 전환 효과, 중복 정리
- [ ] UI/UX 밸런스 audit + 수정(DESIGN.md 기준)

### Phase 19 — Calendar 쓰기 (이벤트 생성)
**Goal:** 카드→직접 모달→Google Calendar 이벤트 생성. **Depends:** Phase 10 OAuth.
**Deliverables:** scope events 업그레이드(재동의) · `CalendarProvider.create_event`+`create_calendar_event` 커맨드 ·
카드 "캘린더 등록"→직접 모달(제목/시간/캘린더/설명)→write, **acceptance 대기 제거**(사용자 폼=사람 결정).
**Done-criteria:**
- [ ] scope events 재동의, 토큰 keychain 유지
- [ ] 직접 모달→이벤트 생성(write), Rust·bounded·graceful, 읽기 레일 무영향

### Phase 20 — Agents & AI surface
**Goal:** Hermes 브리지 + 글로벌 에이전트 바 + CI 봇 알림 + 스킬 레지스트리. **Depends:** 13(16/17 알림).
**Deliverables:** (15) Telegram류 메신저 브리지(봇 토큰/chat keychain, send + bounded getUpdates, 제어 surface) ·
(16) 모든 뷰 상단 에이전트 바(stacked·경과 비례 진행·클릭→Jobs·모든 AI 집계) · (17) Actions `if:failure()` 훅→
네이티브 알림+Q1 escalate(자동 triage 없음·notify 캡) · (21) 인앱 프롬프트+외부 Claude/Codex 스킬 공유 레지스트리.
**Done-criteria:**
- [ ] Hermes 송수신 제어(bounded), 글로벌 에이전트 바, CI 봇 알림(자동 triage 없음)
- [ ] 스킬 레지스트리(인앱+외부, 잡 바인딩), 자동화는 제안 레일+Acceptance(#1/#2)·bounds(#5)

---

## 폐기된 계획 (이력)

### (폐기) 실행 레일 — 옛 Phase 10 (구현 안 함, 2026-05-21)

> 사용자 결정으로 **폐기**. 앱 안에서 Codex가 백로그를 `workspace-write`로 구현 → diff 검수
> → 브랜치 push → draft PR 하던 실행 레일. 사용자가 이미 직접 쓰는 외부 코딩 에이전트
> (Claude Code / Codex / OMC)와 정면 중복이고 더 약한 one-shot 형태라, 가치 대비 위험
> (workspace-write + 토큰 push)이 3-Rail 중 가장 큰 조각이라 통째로 들어냄. 제안 레일
> (Phase 8/9)이 "Codex가 돕고 사람이 결정한다"는 가치를 위험 없이 이미 제공한다.
> 근거: `docs/decisions.md` "Phase 10 — 실행 레일 (폐기)" 항목.

<details><summary>원안 (이력 — 구현 안 함)</summary>

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

</details>

---

## 4. How Ralph should use this

- 한 번에 한 Phase. 그 Phase의 done-criteria 체크박스를 검증 가능한 테스트/관찰로 채울 것.
- 매 Phase 종료 시 INVARIANTS 7개 위반 여부를 reviewer로 확인. 위반 시 done 아님.
- done-criteria가 모두 green일 때만 다음 Phase. 실패는 그 Phase에서 반복.
- 새 결정/트레이드오프는 `docs/decisions.md`(없으면 생성)에 한 줄로 남길 것.
