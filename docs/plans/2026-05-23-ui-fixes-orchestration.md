# Orchestration Plan — UI/UX 미해결 이슈 (자율 페이즈)

> **Status: PENDING APPROVAL — consensus reached.** ralplan(consensus) 산출물.
> 승인 전 구현/커밋/푸시 금지. 사람 승인 시에만 실행(ralph 순차 권장).
> Date: 2026-05-23 · Branch base: `dev` (현재 dev = main +118; push dev only, main은 PR 전용)
> Rev 6 — architect(SOUND-WITH-CHANGES) + critic(APPROVE) + 사용자 모호함 해소(Rev4) +
> eng-review CLEARED(Rev5) + design-review CLEARED(Rev6, DESIGN.md 5표면 스펙 확장) 반영.
>
> **⚠️ 실행 전 점검(tree 안정성)**: 이 세션 중 브랜치가 `refactor/signal-store`↔`dev`로 **저절로
> 바뀌는 것**을 관측함 + 활성 `worktree-agent-*` 워크트리 5개 존재. 동일 워킹트리에서 다른
> 루프/세션이 동작 중일 수 있음(메모리: 트리가 발밑에서 변함). **ralph 시작 전 그 병렬 작업이
> 끝났고 브랜치가 `dev`로 안정됨을 확인할 것.** 아니면 커밋이 엉뚱한 브랜치에 얹힐 위험.

---

## 0. 컨텍스트 / 전제

사용자가 보고한 9개 영역의 미해결 이슈를 **자율 per-PR 페이즈 루프**로 구현한다.
각 페이즈 = 1 PR(한 관심사). 페이즈 간 승인 대기 없음(brainstorm → implement → verify →
critic ACCEPT → commit/push dev). 단, 아래 "tree-coupled" 페이즈는 루프 안에서도 사람 확인 게이트.

### 사용자 확정 결정

- **스킬 레지스트리**: "사라진" 곳은 **Cmd+K 팰레트**. (라우팅된 `g s` Skills 화면은 정상.)
- **캐싱**: **하이브리드** — 프론트 react-query 영속화 + Rust TTL 캐시(stale-while-revalidate).
- **순서**: **버그 먼저 → 기능**. 캘린더 drawer는 Today/제안 긴급도보다 먼저.
- **P11 스프린트(둘 조합)**: `interval_days` + `anchor`(기준요일·시각). 단일 전역 1개(v1).
- **P4 프로젝트별 스킬**: **표시 그룹핑만**(스키마 무변경, 현재 프로젝트 우선 노출).
- **P8 캘린더 긴급도**: **제목/키워드 매칭**(퍼지) → `suggested_*` 가중만, 자동 이동 없음.
- **P10 진행/너비**: **경과 시간 기반**. codex=timeout 비율, hermes/cmux=경과만+width 상한.

### 확정 가정 (이의 없으면 이대로 진행 — B급 모호함 해소)

- **Cmd+화살표**: 좌/우만 인접 뷰 전환(상/하 미사용).
- **노션 딥링크 대상**: 등록 성공 시 **생성된 페이지**(+https fallback).
- **캘린더 drawer 소스**: 기존 Google Calendar, **읽기 전용 보기**(드로어 내 일정 생성 범위 밖).
- **"전체 제안 실행" 모달 내용**: 기존 per-card enrich 리뷰(분류/우선순위 제안)를 점프 없이 모달로 이전.
- **캐싱 "전역" 범위**: PR Radar / worktree / Notion / Calendar 읽기.
- **Today 캘린더 "표시 안 됨"**: 미구현이 아니라 **Google OAuth 미연결로 빈 상태**일 가능성 → P9는
  날짜 네비 + **미연결 시 연결 유도 빈 상태 UX** 포함.
- **Brain dump 입력 "너무 하단"**: 명백 코드 버그 미발견 → **P5에서 chrome 확정 후 시각 검증·판정**
  (재현 불가 시 no-op).

### 환경 제약 (반드시 준수)

- **작업 트리 공유**: 워킹트리에 사용자 _진행 중_ 미커밋 변경 존재 — `styles.css`, `nav.ts`,
  `SkillsView.tsx`, `TodayView.tsx`, `TimelineView.tsx`, `RoutinesPanel.tsx`, `useListReorder.ts`,
  `docs/decisions.md`. **stash/checkout/commit 금지.** → "워킹트리 충돌 프로토콜"(§ 끝) 준수.
- **cargo PATH**: `export PATH="$HOME/.cargo/bin:$PATH"` 를 cargo 실행 **및** git commit
  전에(husky pre-commit cargo fmt) 매번 적용.
- **rtk cargo 요약 불신**: 검증은 `rtk proxy cargo ...` 로 실제 출력 확인.
- **에이전트 병렬 worktree 오염**: 한 페이즈 안 executor 에이전트도 **순차** 실행.
- **executor 늦은 쓰기**: 커밋 전 / 다음 브랜치 전 `git status` 확인.

### INVARIANTS (PLAN.md §1 — 강제)

1. 결정 레일은 사람만 — 자동 분류/자동 승격 금지. **(P1, P4, P8 핵심)**
2. 모든 외부 변경은 Acceptance 게이트.
3. 신호 dedup upsert + auto-resolve.
4. 매트릭스 = 결정 큐, ambient는 임계치 escalate.
5. 에이전트 잡 timeout/turns/cost cap/kill + 재트리거 캡.
6. 코드 작업 worktree 격리, 사용자 트리 무손상.
7. SSOT 분리 (Notion=내용, SQLite=상태). **(P4 스킬 스키마, P6 캐시 핵심)**

### 기술 제약 (AGENTS.md)

- Tauri 2 + Vite + React. **IPC는 tauri-specta**로 생성 — `src/bindings.ts` 수기 편집 금지(생성물).
- Notion/GitHub 호출은 Rust. 토큰은 keyring. SQLite 평문 금지.
- 스키마 변경은 **sqlx 마이그레이션만**. 임의 ALTER 금지.
- bounded retry only. 시각 디자인은 `DESIGN.md`(Cohere white editorial) 정본.

### 페이즈 공통 Done-criteria 번들 (각 PR)

- [ ] `pnpm typecheck` green (+ FE 로직 변경 시 해당 `pnpm test <file>` 단위 green).
      **`pnpm lint` 사용 금지 — lint 스크립트 없음**(`docs/reference/commands.md` 명시).
- [ ] Rust 변경 시 `cargo test` + `cargo clippy` green (`rtk proxy cargo`로 확인)
- [ ] IPC 변경 시 `src/bindings.ts` 재생성 (수기 편집 금지)
- [ ] UI 변경 시 `pnpm tauri dev` 부팅 + **스크린샷 증거**
- [ ] 별도 reviewer(critic) 패스 ACCEPT (self-approve 금지)
- [ ] INVARIANT 위반 없음(특히 #1) — reviewer 명시 확인
- [ ] `docs/decisions.md`에 결정/트레이드오프 한 줄

---

## RALPLAN-DR 요약

**Principles**

1. 버그(명백한 결함)를 기능 신설보다 먼저 — 빠른 체감 개선 + 작은 표면적.
2. 공통 의존(캐싱, 캘린더 컴포넌트/range API)은 소비 직전 도입 — 재작업 최소.
3. 결정 레일(분류·승격·제안 적용)은 절대 자동화 금지(INVARIANT #1). 자동화는 *제안*까지만.
4. 가장 작은 국소 변경. 기존 프리미티브(app_config 등) 재사용. 사용자 미커밋 워킹트리 무손상.

**Decision Drivers (top 3)**

1. 체감 개선 속도("여전히 안 됨" 반복 → 신뢰 회복 우선).
2. 의존성 위상(캐싱 → 캘린더 range → 캘린더 소비 기능; chrome 높이 → 캡쳐 레이아웃).
3. INVARIANT/모델 위험(P8 제안실행, P11 sprint 모델).

**Viable Options (순서 전략)**

- **(채택) 버그 먼저 → 기반 → 기능 → chrome → 레이아웃 정합**: P1–P4 버그, P6 캐싱·P7 캘린더
  range/drawer 기반, P8–P9 캘린더 소비 기능, P10a/P10b 에이전트 바, P11 스프린트, **P5(캡쳐
  레이아웃)는 chrome 확정 후 마지막**.
  - +: 빠른 신뢰 회복, 의존성 정합, P5 재작업 제거, 위험 페이즈 후순위.
  - −: 캡쳐 레이아웃 정합이 가장 늦음(단, chrome 미확정 상태 수정은 무의미).
- (기각) 기반 먼저: 첫 체감 개선 늦음 — 사용자 우선순위와 충돌.
- (기각) P5를 버그군에서 먼저: P5 증상이 P10(더 높은 바)의 표면 → 먼저 고치면 P10이 재유발.

---

## 실행 순서 / 페이즈 개요

> 실행 순서 = 아래 표 순서. (페이즈 ID는 영역 식별용; 순서는 의존성·architect 교정 반영.)

| 순서 | ID   | 페이즈                                                   | 분류         | 의존     | tree-coupled\*                                  |
| ---- | ---- | -------------------------------------------------------- | ------------ | -------- | ----------------------------------------------- |
| 1    | P1   | Notion 백로그: DB ID 매칭 + 프로젝트 선택 + 딥링크       | 버그         | —        | —                                               |
| 2    | P2   | 브레인덤프 제목 인라인 편집(window.prompt 제거)          | 버그         | —        | styles.css                                      |
| 3    | P3   | 단축키: Cmd+화살표 인접뷰 전환                           | 버그         | —        | nav.ts                                          |
| 4    | P4   | 스킬: Cmd+K 팰레트 복원 + 프로젝트별 그룹핑(표시)        | 버그+기능    | —        | SkillsView.tsx                                  |
| 5    | P6   | 캐싱 레이어 (하이브리드, 전역)                           | 기반         | —        | —                                               |
| 6    | P7   | 캘린더 range API + drawer(일/주/월)                      | 기반         | P6       | —                                               |
| 7    | P8   | 전체 제안 실행: 백그라운드 + 인보드 모달 + 캘린더 긴급도 | 기능·고위험  | P6,P7    | RoutinesPanel.tsx                               |
| 8    | P9   | Today: 오늘 일정 + < > 날짜 네비                         | 기능         | P7       | TodayView.tsx, useListReorder.ts, TodayRail.tsx |
| 9    | P10a | 에이전트 바 시각 재설계(정체성 박스)                     | 기능         | (P6)     | styles.css                                      |
| 10   | P10b | 에이전트 바 이름 편집 persist(app_config)                | 기능         | P10a     | —                                               |
| 11   | P11  | 헤더 스프린트 타이머 + 일정 편집                         | 기능·모델    | —        | —                                               |
| 12   | P5   | 캡쳐보드 입력 영역 레이아웃 정합                         | 버그(검증요) | P10a,P11 | styles.css                                      |

\* tree-coupled = 사용자 미커밋 파일을 구조적으로 수정 → 루프 안에서도 **사람 확인 게이트**.
(모든 페이즈가 `docs/decisions.md`를 EOF append 하지만, 비교집합이라 충돌 회피 — 표에는 미표기.
상세는 "워킹트리 충돌 프로토콜" 참조.)

---

## P1 — Notion 백로그: DB ID 매칭 + 프로젝트 선택 + 딥링크 〔버그〕

**증상**: "프로젝트에 Notion DB ID가 설정되지 않음" — 실제로는 업무 영역에 설정됨.

**근본 원인**(`commands/notion.rs` `resolve_notion_target` ~L207–294):

- `>1` 같은-kind 후보 → **이미** 프로젝트 선택 에러 반환(picker 경로 존재).
- `1` 후보 → **자동 assign + project_id persist**(편의 태깅). 시그널이 잘못된 단일 후보로
  묶이면 그 프로젝트 DB ID가 NULL → 에러.
- 최종 에러가 **어느 프로젝트인지 안 알려 줌**.
- **주의(verify)**: 백엔드는 이미 `resolved_project_id`를 INVARIANT #1 라벨과 함께 반환(notion.rs
  ~L294–299) → P1은 "FE surfacing 마무리·검증 + 딥링크 추가"에 가깝고 _바닥부터 구축 아님_.
  첫 brainstorm 스텝에서 실제 잔여 범위 확정.

**Deliverables**

1. **단일 후보 auto-persist 정책 결정**(architect 지적): (a) 편의 유지 + 명확한 안내, 또는
   (b) 확인 가능(confirmable)으로 전환. INVARIANT #1 정합. 브레인스토밍에서 확정 → decisions.md.
2. `>1` picker: FE가 후보를 실제로 surface(현재 에러 문자열만일 수 있음 — 확인 후 필요시
   구조화 에러 `NeedsProjectPick`). 선택 결과 persist.
3. DB ID NULL 시 에러에 **프로젝트명 + "설정 열기"** 액션.
4. **Notion 딥링크**: 성공 시 `notion://` + https fallback로 페이지/DB 열기
   (`notion.rs post_page` 이미 url 반환 → deeplink 변환).

**파일 / 주의**: Rust `commands/notion.rs`, `notion.rs`; FE 프로젝트 선택 모달(ProjectCard/
AddProjectForm 패턴 재사용). **`CaptureBoard.tsx:216` window.prompt(프로젝트 picker)은 P1
소관** — P2(제목 :282)와 같은 `handleMenuAction` 영역을 양쪽이 반쪽씩 고치지 않도록 P1이 먼저.
IPC 변경 → bindings 재생성.

**Done-criteria (공통 +)**

- [ ] `>1` 후보에서 선택 모달(스크린샷). 업무 영역으로 등록 성공 + 딥링크 열림(관찰).
- [ ] DB ID 미설정 프로젝트 선택 시 에러에 프로젝트명 + 설정 링크.
- [ ] 단일 후보 정책이 결정대로 동작(관찰).
- [ ] **unit 테스트(cargo)**: notion 딥링크 빌더 — page url/uuid → `notion://` + https fallback 변환.
- [ ] INVARIANT #1: 프로젝트 자동확정 없음(또는 결정된 확인 흐름). #2: Acceptance 게이트 유지.

---

## P2 — 브레인덤프 제목 인라인 편집 〔버그〕

**근본 원인**: `CaptureBoard.tsx:282` **`window.prompt`** — Tauri webview에서 비신뢰/미동작.

**Deliverables**

1. `:282` 제목 편집을 **인라인 편집**(편집 아이콘/더블클릭 → input)로 교체. (`:216` 프로젝트
   prompt은 P1 소관 — 본 페이즈 범위 밖.)
2. `useUpdateSignalTitle` 성공 후 `signals` invalidate로 즉시 반영.

**파일 / 주의**: FE `CaptureBoard.tsx`, postit 카드, `styles.css`(인라인 편집 스타일 — **append-only**,
워킹트리 충돌 프로토콜 적용).

**Done-criteria (공통 +)**

- [ ] 제목 인라인 편집 → 저장 → 재조회 후 유지(관찰+스크린샷).
- [ ] 제목 편집 경로에 `window.prompt` 잔존 없음(grep).

---

## P3 — 단축키: Cmd+화살표 인접뷰 전환 〔버그〕

**근본 원인**(`src/lib/useViewShortcuts.ts:59`): `if(e.metaKey||e.ctrlKey||e.altKey) return;`
모든 modifier 차단 → Cmd+화살표 불가. 화살표 keymap 부재.

**Deliverables**

1. `NAV_ITEMS` 순서 기반 prev/next 유틸.
2. Cmd+←/→(mac)/Ctrl+←/→ → 인접 뷰. editable target / 팰레트 오픈 시 비활성. 기존 chord 보존.

**파일 / 주의**: FE `useViewShortcuts.ts`, `nav.ts`. **`nav.ts` 사용자 미커밋(아이콘)** — 충돌 프로토콜.

**Done-criteria (공통 +)**

- [ ] **unit 테스트(vitest)**: nav prev/next 인접 유틸 — 첫/마지막 뷰 wrap 동작, 순서 정확성.
- [ ] Cmd+→/← 뷰 전환(키 입력 관찰). input 포커스 중 캐럿 이동 보존. 기존 chord 회귀 없음.

---

## P4 — 스킬: Cmd+K 팰레트 복원 + 프로젝트별 그룹핑 〔버그+기능〕

**선행 조사**(첫 스텝): Cmd+K 팰레트 컴포넌트·항목 소스 확인 — 스킬 항목 (a)제거/(b)조건부 숨김/
(c)`list_skills` 미사용 중 무엇인지.

**Deliverables**

1. 팰레트에 스킬(in-app + external) **복원**. 선택 동작은 기존 레일(제안까지, 자동 실행 금지).
2. **프로젝트별 목록 = 표시 전용 그룹핑(option B 채택)**. Skill 스키마(migration 0013)는
   의도적으로 `project_id` 없음 + SSOT 주석(INVARIANT #7). **option A(스키마 scope)는 0013 SSOT
   결정을 재오픈하므로 기각** — 하드 요구가 없으면 현재 프로젝트 우선 노출/그룹핑으로 처리.

**파일 / 주의**: FE 팰레트 + (필요시) skills 조회. 스키마 변경 없음(B). **`SkillsView.tsx` 미커밋
(아이콘)** — 충돌 프로토콜.

**Done-criteria (공통 +)**

- [ ] Cmd+K에서 스킬 검색·노출(스크린샷). 프로젝트 우선 그룹핑 동작.
- [ ] INVARIANT #1: 팰레트 선택이 잡 자동확정/실행 안 함(awaiting_approval 유지). #7: 스키마 무변경.

---

## P6 — 캐싱 레이어 (하이브리드, 전역) 〔기반〕

**현황**: `@tanstack/react-query` v5 in-memory만. PR Radar 3분/worktree 8s 폴링이 매번 fresh.
Rust측 캐시 없음. (`@tanstack/react-query-persist-client`는 **미설치 → 본 페이즈가 추가**.)

**브레인스토밍**(첫 스텝 → decisions.md):

- 프론트: `@tanstack/react-query-persist-client` + storage(localStorage/IndexedDB), 버전/만료.
- Rust TTL: **`moka`(TTL + bounded size + concurrency) 권장**(hand-rolled HashMap 지양 — bounded
  ethos). 외부 HTTP(GitHub/Notion/Calendar) **읽기 가속 전용**.

**Deliverables**

1. 프론트 react-query persist 도입(부팅 복원).
2. Rust TTL 캐시 유틸 + 외부 읽기(PR Radar/calendar/Notion)에 적용. 강제 새로고침 경로 유지.
3. 전역 적용 가이드라인 한 줄(decisions.md).

**INVARIANT 펜스(done-criteria로 강제, 코드 ref 명시)**

- [ ] **escalation(#4) 읽기 경로**(`pr_radar.rs`, `triage.rs`, `agents/mod.rs`의 escalate 판정
      읽기)가 TTL 캐시를 소비하지 않음 — grep로 캐시 호출 부재 확인.
- [ ] **accept·promotion(#2) 쓰기 경로**(`enrich.rs` accept, `notion.rs` 등록)가 캐시를 읽지
      않고 SQLite/fresh 사용 — grep 확인.
- [ ] **결정 큐 disk-persist 제외**(eng-review): 매트릭스/시그널 등 사람이 결정하는 데이터는
      react-query **영속화 대상에서 제외**(persist allowlist/denylist) — 재시작 시 fresh 로드.
      (stale 데이터로 인한 잘못된 _사람_ 판단 방지. ambient 가속만 persist.)
- [ ] #7: 캐시는 표시 가속만, 상태 SSOT는 SQLite 유지.

**Done-criteria (공통 +)** — _Rev 7: 구현 중 PR Radar는 fetch+escalate 한 패스라 캐시 금지(#4) 발견 → 캐시 대상은 캘린더로 한정. PR Radar 표시는 프론트 persist로만 가속. 아래는 그 현실 반영._

- [x] 앱 재시작 후 PR Radar/Today **표시** 캐시 즉시 복원(프론트 react-query persist allowlist `prRadar`/`calendarEvents`/`todayOverview` 등) → 백그라운드 갱신. (자동 단위테스트 외 부팅 육안 관찰은 P7/사용자 측에서 권장.)
- [x] **강제 새로고침 capability를 IPC로 배선**: `fetch_calendar_events(force_refresh)` → `get_or_fetch(force=true)` 캐시 우회. cargo test `force_bypasses_cache` + TTL 만료/적중 green. **관찰용 새로고침 UI는 P7 캘린더 드로어 버튼 소관**(P6는 백엔드 capability + 단위테스트로 충족).
- [x] **호출 횟수 절감(캘린더로 재정의)**: PR Radar는 의도적 비캐시(#4)라 측정 대상 아님. 캘린더 캐시 hit 시 underlying Google fetch 미호출을 cargo test(`hit_within_ttl_skips_fetcher`: 2회 호출→1 fetch, `concurrent_misses_coalesce_to_single_fetch`)로 단언 + miss 시 `tracing::debug!` 로그로 런타임 관측 가능.
- [x] `moka` 0.12 추가 → decisions.md 한 줄(+ PR-Radar-비캐시 사유 기록). TTL=60s(프론트 staleTime 정합), bounded 256, `try_get_with` 코얼레싱, 에러 미캐싱.

---

## P7 — 캘린더 range API + drawer(일/주/월) 〔기반〕

**현황**: `CalendarEventModal`은 단일 카드 _등록_ 모달뿐. 조회 캘린더 뷰 없음.
**중요(architect)**: `commands/calendar.rs fetch_calendar_events`는 `calendar::today_window`로
**하루 범위 고정** → 주/월 뷰는 N×Google 호출이 아니라 **신규 range 커맨드 필요**(P6 먼저).

**Deliverables**

1. **신규 캘린더 range 커맨드**(`time_min`/`time_max`) — Rust + IPC + bindings. bounded 1콜/범위.
2. 캡쳐보드 **우측 슬라이드 드로어 캘린더**(today-rail 위 오버레이/확장): 일/주/월 전환 + 날짜 네비.
   <720px는 하단 시트. 시각 스펙 = DESIGN.md `calendar-drawer`.
3. 재사용 `CalendarView` 컴포넌트(P9 Today, P8 긴급도 재사용). 날짜 유틸 필요 시 경량 `date-fns`
   도입(브레인스토밍 — 현재 native Date).

**파일**: Rust `commands/calendar.rs`(range), FE 신규 `CalendarView`/`CalendarDrawer`. 다중 프로젝트 calendar id.

**Done-criteria (공통 +)**

- [ ] **unit 테스트(cargo)**: range 커맨드 `time_min`/`time_max` 경계 계산 — 일/주/월 각 범위 정확성.
- [ ] drawer 일/주/월 전환 + 이벤트 표시(스크린샷 3종).
- [ ] P6 캐시 적용(재방문 즉시 표시). 주/월이 단일 range 콜(폴링 로그 — N콜 아님).

---

## P8 — 전체 제안 실행: 백그라운드 + 인보드 모달 + 캘린더 긴급도 〔기능·고위험〕

**현황(architect)**: `handleEnrichAll`(`src/components/CaptureBoard.tsx` ~L240–256)는 **이미
게이트됨** — 잡 트리거 후 `goTo("jobs")`, 잡은 awaiting_approval로 안착. **P8은 실행 레일
신설이 아니라 표시 위치 이전**(jobs 페이지 → 인보드 모달). 잡 캡(`timeoutSec:180`/`maxTurns:12`/
`costCapUsd:1.0`, 심볼 기준) 유지.

**Deliverables**

1. **백그라운드 실행**: 페이지 이동 없이 백그라운드 잡 + **로컬 진행 표시**. P8의 로컬
   인디케이터는 **영구 fallback**이며, P10b의 에이전트 바 통합은 *추가(additive)*일 뿐 P8을
   throwaway로 만들지 않음. **P8은 agent-bar에 의존하지 않음**.
2. **완료 시 보드 내 인라인 리뷰 패널**(오버레이 모달 아님 — 카드 계속 보임) 결과 표시 +
   **사람이 수정·승인 후 반영**. 자동 적용 금지. 시각 스펙 = DESIGN.md `enrich-review-panel`.
3. **캘린더 긴급도(제목/키워드 매칭)**: 카드 제목/키워드를 캘린더 이벤트 제목과 매칭해, 연관
   이벤트가 임박하면 그 카드 긴급도를 가중 — **`suggested_*`에만**. 매칭은 **퍼지 휴리스틱**(완벽
   매칭 불필요)이며, 매칭/가중이 카드를 **자동 이동시키지 않는다**(INVARIANT #1).

**INVARIANT 펜스(done-criteria로 강제)**

- [ ] **표시 전용 변경 — accept-writes-`suggested_*` 게이트 경로 무변경**(코드 ref).
- [ ] **긴급도 가중은 `suggested_*`에만 반영, 카드 자동 이동 없음**(코드 ref).
- [ ] INVARIANT #1: 사람 승인 없이 매트릭스 분류/승격 변경 없음(critic 명시). #5: 잡 캡 유지.

**Done-criteria (공통 +)**

- [ ] 실행 후 페이지 이동 없음 + 로컬 진행 표시(관찰). 완료 시 인보드 모달 + 수정 + 승인 시에만 반영.
- [ ] **unit 테스트(cargo) — 긴급도 점수 함수**: 미분류 시그널 1개 + **제목/키워드가 매칭되는**
      캘린더 이벤트를 N시간 이내로 둔 케이스에서, `suggested_*` 점수가 매칭 이벤트 없을 때보다
      **상승**함을 단언(전/후 점수). 카드 위치 자동 이동은 **없어야** 함(단언).

---

## P9 — Today: 오늘 일정 + < > 날짜 네비 〔기능〕

**현황**: `TodayView`는 오늘 이벤트만, **날짜 네비 없음**.

**Deliverables**

1. Today 헤더 **< > 날짜 네비**("오늘로" 포함).
2. 선택 날짜로 캘린더 일정 + overview 재조회(P7 `CalendarView`/날짜 유틸 재사용, 쿼리키에 date).
3. **캘린더 미연결 빈 상태 UX**: TodayView는 이미 오늘 이벤트를 표시하므로, "표시 안 됨"의 실제
   원인이 Google OAuth 미연결일 수 있음 → 미연결 시 연결 유도 안내(빈 화면 방치 금지).

**파일 / 주의**: FE `TodayView.tsx`. **사용자 미커밋** — 충돌 프로토콜.

**Done-criteria (공통 +)**

- [ ] < > 날짜 이동 + 해당일 일정/overview 갱신(스크린샷). P6 캐시로 즉시 표시.

---

## P10a — 에이전트 바 시각 재설계(정체성 박스) 〔기능〕

**현황**: `AgentStatusBar`는 8px 얇은 트랙 + 6–28px 미니 세그먼트. width 성장·진행 fill 이미 존재.
cmux=별도 chip(표시 전용, #1-safe), hermes=engine. **주의(architect)**: `agent_runs` rows가 없을
수 있어 P10a/b는 *runs*뿐 아니라 **세션 enumerate** 필요(hermes/cmux 각 1박스).

**Deliverables (시각만 — FE)**

1. 바 height 증가 → 각 세션이 **박스**(아이콘 + 이름 표시).
2. **상태 표시**(idle/working/error) 시각 구분.
3. **프로그레스 백필 = 경과 시간 기반**(박스 채움): codex 잡은 `elapsed/timeout` 비율(기존 fill
   확장), **timeout 없는 hermes/cmux 세션은 경과 시간만**으로 채움(상한 도달 시 포화).
4. **헤르메스·cmux 세션 각 1박스**(세션 enumerate). **개수 상한**(예: 8) + 초과 시 **'+N' 오버플로
   칩**(잡 `MAX_SEGMENTS=12`와 일관). 바 넘침 방지.
5. **width = 경과 시간 기반**: idle=초기 width, 작업 지속 시 증가. 외부 세션은 경과만 반영하고
   **width 상한** 적용(무한 증가 금지 — bounded ethos).

**파일 / 주의**: FE `AgentStatusBar.tsx` 개편 + `styles.css`(박스/상태/백필, DESIGN.md 정합 — **append-only**).
**사용자 미커밋 styles.css** — 충돌 프로토콜.

**Done-criteria (공통 +)**

- [ ] **unit 테스트(vitest)**: 경과→width / 진행 ratio 순수 함수 — idle=초기, 경과 증가 시 단조
      증가 + 상한 포화, count cap/오버플로 계산.
- [ ] 박스 아이콘+이름+상태+백필(스크린샷 idle/working/error). hermes/cmux 각 1박스. 지속 시 width 증가.
- [ ] INVARIANT #1: cmux/표시 데이터가 결정 로직 미진입(기존 불변 유지).

---

## P10b — 에이전트 바 이름 편집 persist 〔기능〕

**현황(architect)**: 이름 persist 위치 = **기존 `app_config`(migration 0014, per-machine
key-value, #7-호환)** 사용 — 신규 테이블/마이그레이션 불필요. 키 예: `agent.name.<sessionKey>`.

**Deliverables**

1. 박스 이름 **인라인 편집** + `app_config`에 persist.
2. (선택) P8 백그라운드 진행을 에이전트 바에 통합(P8 로컬 인디케이터 → 바 연동).

**파일**: FE `AgentStatusBar.tsx`, Rust `app_config` 읽기/쓰기 커맨드(있으면 재사용) + bindings.

**Done-criteria (공통 +)**

- [ ] 이름 편집 후 재시작에도 유지(관찰). #7: app_config(per-machine) 사용, 상태 SSOT 침범 없음.

---

## P11 — 헤더 스프린트 타이머 + 일정 편집 〔기능·모델〕

**현황**: sprint 개념 전무. 글로벌 헤더 없음(뷰별 로컬 + AgentStatusBar).

**Deliverables**

1. **스프린트 설정 저장**: v1은 **단일 글로벌 스프린트** → **`app_config`로 충분(YAGNI)**.
   다중 스프린트/이력이 요구되면 그때 `sprints` 테이블(마이그레이션). 브레인스토밍에서 확정.
   **모델 = 길이 + 경계 앵커 조합**(사용자 확정): `interval_days`(예: 14) + `anchor`(기준요일+시각,
   예: 금 21:00). 다음 경계 = anchor 정렬 + interval 주기로 계산. **절대 종료시각 저장 지양**
   (drift 방지, 매번 계산).
2. **브랜드 헤더("Work Radar / …") 우측 존에 카운트다운**(에이전트 바와 분리). 남은 day:HH:MM,
   1s tick, overdue=Coral+라벨. 시각 스펙 = DESIGN.md `sprint-timer`.
3. **타이머 클릭 → 일정 편집**(길이/기준요일/시각, recurrence). 베스트프랙티스 UX.

**파일**: Rust(sprint 설정 read/계산 커맨드; 다음 경계 계산), FE(헤더 타이머 + 편집 모달), bindings.

**Done-criteria (공통 +)**

- [ ] **(주 기준) cargo test: 다음 스프린트 경계 계산 단위 테스트 green** — 고정 anchor(예:
      2026-05-23 기준, 매주 금 21:00, 14일 주기)에 대해 다음 경계·남은 시간을 단언. **rrule 미사용
      =직접 구현**(eng-review 결정): 로컬 타임존 기준 + **DST/일광절약 경계** 케이스를 단위 테스트에
      명시 포함(반복 계산이 깨지는 지점).
- [ ] 헤더 카운트다운이 위 계산값과 **일치**함을 관찰(스크린샷). 클릭 → 편집 → 저장 → 반영.
- [ ] (테이블 도입 시) 마이그레이션 부팅 확인.

---

## P5 — 캡쳐보드 입력 영역 레이아웃 정합 〔버그·검증요·마지막〕

**재배치 이유(architect)**: 사용자 증상("입력창이 너무 하단")의 가용 높이는 \*\*에이전트 바(P10a)

- 헤더 타이머(P11)** 가 결정. 그래서 **chrome 확정 후 마지막\*\*에 단 한 번 판정·정합.

**Deliverables**

1. P10a/P11 적용된 상태로 `pnpm tauri dev` → 캡쳐보드 스크린샷으로 실제 문제 판정
   (titlebar drag region, 바 높이, 100vh vs 실제 가용 높이).
2. 재현되면 입력 영역 가독 위치 정합(DESIGN.md). **재현 안 되면 "재현 불가 + 근거 스크린샷"
   보고 후 종료(억지 변경 금지).**

**파일 / 주의**: FE `CapturePanel.tsx`, `CaptureBoard.tsx`, `styles.css`(**append-only**, 충돌 프로토콜).

**Done-criteria (공통 +)**

- [ ] before/after 스크린샷(또는 재현 불가 근거). 입력창 가시·접근성 양호. P10/P11 회귀 없음.

---

## 워킹트리 충돌 프로토콜 (tree-coupled 페이즈 공통)

**사용자 미커밋 파일 전체 목록**(루프 시작 시점 기준): `styles.css`, `nav.ts`, `SkillsView.tsx`,
`TodayView.tsx`, `TimelineView.tsx`, `useListReorder.ts`, `board/RoutinesPanel.tsx`, `docs/decisions.md`.
(+ 소비 인접: `board/TodayRail.tsx`가 `useListReorder.ts`를 씀.)

**플랜 산출물(동결 대상 아님 — 사용자 작업과 구분)**: `DESIGN.md`(이번 design-review에서 신규
5표면 스펙 추가), `docs/plans/2026-05-23-ui-fixes-orchestration.md`(이 플랜, untracked). 둘 다
_사용자 진행작업이 아니라_ 본 플랜의 산출물 → tree-coupled 동결 대상에서 제외하고, **DESIGN.md는
관련 UI 페이즈(P7/P10a/P11) 또는 첫 페이즈에서 함께 커밋**(경로 지정 add). 플랜 파일은 참조용.

**파일 → 영향 페이즈 매핑**(해당 페이즈는 tree-coupled = 사람 확인 게이트):

- `styles.css` → P2, P10a, P5 (인라인편집/박스/레이아웃 스타일)
- `nav.ts` → P3 (순서 유틸)
- `SkillsView.tsx` → P4 (팰레트 작업이 SkillsView를 건드릴 경우)
- `TodayView.tsx`, `useListReorder.ts`, `board/TodayRail.tsx` → P9 (Today 날짜 네비)
- `board/RoutinesPanel.tsx`, `useListReorder.ts` → P2/P5/P8 (CaptureBoard가 RoutinesPanel 렌더)
- `docs/decisions.md` → **모든 페이즈**(공통 done-criteria가 매 PR decisions.md 한 줄 요구)
- `TimelineView.tsx` → 직접 범위 밖이지만 변경 금지 목록에 포함(무손상 확인)

**규칙**:

1. **루프 시작 전 1회**: `git stash create`(트리 **무변경** read-only 스냅샷 ref)로 사용자 hunk
   범위를 기록.
2. **"충돌" 정의**: 페이즈가 편집할 라인 범위가 동일 파일의 사용자 hunk와 **교집합**일 때.
3. **append-only 원칙**: `styles.css`는 기존 셀렉터 수정 대신 **파일 끝 신규 블록 추가**.
   `docs/decisions.md`도 **파일 끝 append-only**(사용자 hunk와 비교집합 → 충돌 회피).
4. **tree-coupled 페이즈는 자율 루프 안에서도 사람 확인 게이트**. 충돌 검출 시 **중단·보고**,
   자동 진행 금지. (그 외 페이즈는 무중단 자율.)

---

## 실행 모델 (승인 후)

- **권장: ralph 순차** — 페이즈당 1 PR, per-PR 자율 루프(brainstorm → implement(순차 에이전트) →
  verify(실제 실행 증거) → critic ACCEPT → commit/push **dev**). 비-tree-coupled 페이즈는 무중단.
- 병렬 worktree 금지. dev에 직접 페이즈 커밋(페이즈별 브랜치 아님).

### 커밋 스테이징 규율 (사용자 트리 무손상 — INVARIANT #6)

- **`git add -a` / `git add .` 금지.** 그 페이즈가 _실제로 수정·생성한 파일만_ 경로 지정으로 add.
  (생성물 `src/bindings.ts`는 IPC 변경 페이즈일 때만, 수기 편집 없이 재생성 결과를 함께 add.)
- 커밋 **전/후 `git status`** 로 사용자 미커밋 8개 파일이 여전히 `unstaged( M)` 인지 단언.
  하나라도 staged 되면 **중단·보고**(언스테이지 후 재시도).
- `docs/decisions.md`: 매 PR 한 줄은 **EOF append**. **단, 사용자 미커밋 hunk도 EOF append라
  인접** → `git add docs/decisions.md`는 사용자 줄까지 스테이징하고, 이 환경엔 라인 단위 staging
  (`git add -p/-e` 인터랙티브)이 없다. 따라서 **사용자 decisions.md hunk가 미커밋인 동안에는**
  그 페이즈의 decisions 한 줄을 **사용자에게 넘겨 보고**(또는 사용자에게 본인 decisions.md hunk를
  먼저 커밋해 달라고 요청)한다. 깨끗한 per-line staging을 가정하지 않는다.

### 롤백 / 실패 캡

- **롤백**: 페이즈 N 커밋이 dev에 올라간 뒤 N+1에서 N의 결함이 드러나면 `git revert <N커밋>` 으로
  되돌림(reset/force 금지 — dev 히스토리 보존).
- **실패 캡**: 한 페이즈의 implement→verify→critic 루프는 **최대 3회 재시도**. 3회 내 critic
  ACCEPT 실패 시 그 페이즈에서 **중단·사람 에스컬레이션**(다음 페이즈로 자동 진행 금지).
- **P5 no-op 허용**: P5가 "재현 불가"로 판정되면 코드 변경 없는 **no-op 종료**(억지 변경·빈 커밋
  강요 금지) — 근거 스크린샷만 보고하고 다음으로.

## 위험 / 미해결

- **P1 단일후보 auto-persist**: 편의 유지 vs confirmable — 브레인스토밍 확정.
- **P5**: 코드상 명백 버그 미발견 → chrome 확정 후 시각 판정(억지 변경 금지).
- **P7**: range 커맨드는 신규 Rust+IPC 작업(과소평가 금지). P6 먼저.
- **P8**: 표시 전용·게이트 무변경·긴급도는 suggested\_\*에만 — critic 집중(#1).
- **P10/P11**: app_config 재사용으로 최소화. P11 테이블은 다중 요구 시에만.
- **워킹트리 공유**: 충돌 프로토콜 준수, 충돌 시 중단·보고.
- **브랜치 불안정(신규)**: 세션 중 브랜치가 저절로 바뀜(refactor/signal-store↔dev) + 활성
  worktree-agent-\* 5개. ralph 시작 전 **병렬 루프 종료 + dev 고정**을 확인. 각 페이즈 커밋 직전
  `git rev-parse --abbrev-ref HEAD`로 dev인지 재확인(엉뚱한 브랜치 커밋 방지).

## ADR (요약)

- **Decision**: 9개 영역을 12 페이즈(P10 분할) per-PR 자율 루프로, 버그(P1–P4) → 기반(P6 캐싱/P7
  캘린더 range·drawer) → 캘린더 소비 기능(P8–P9) → 에이전트 바(P10a/b) → 스프린트(P11) →
  캡쳐 레이아웃 정합(P5, 마지막) 순서.
- **Drivers**: 체감 개선 속도, 의존성 위상, INVARIANT/모델 위험.
- **Alternatives**: 기반 먼저(체감 늦음·기각), P5 먼저(P10이 재유발·기각), P4 스키마 scope(0013
  SSOT 재오픈·기각), P10 단일 PR(과대·분할), P11 즉시 테이블(YAGNI·app_config 우선).
- **Why chosen**: 사용자 우선순위("버그 먼저") + 의존성 정합(캐싱→range→소비, chrome→레이아웃)
  - INVARIANT 펜스의 done-criteria화 + 기존 프리미티브(app_config) 재사용.
- **Consequences**: 캡쳐 레이아웃 정합이 마지막. 캐싱·캘린더 range가 후속 기능 가속. 신규 마이그레이션 최소.
- **Follow-ups(잔여)**: P1 단일후보 정책, P7 date-fns 도입, P11 single vs table(현재 app_config),
  P6 `moka` 크레이트 추가 승인(브레인스토밍 산출), `app_config`(0014)를 범용 per-machine KV로
  쓰는 것(P10b 이름/P11 스프린트 키) decisions.md 명시.
- **해소됨(Rev 4)**: P4 그룹핑=표시 전용, P8 긴급도=제목/키워드 매칭, P10 진행/너비=경과 시간,
  P11 모델=길이+앵커 조합. + B급 가정(Cmd 좌우, 딥링크=페이지, 캘린더 읽기전용, enrich 모달 이전,
  캐싱 범위, Today OAuth 빈상태, Brain dump 검증후 판정).
- **해소됨(Rev 5, eng-review)**: P11 rrule 미사용=직접 구현+DST 테스트, P6 결정 큐 persist 제외,
  순수함수 5개 unit 테스트(P3/P10a/P8/P1/P7), P10a 박스 개수 상한+'+N'.

---

## ENG-REVIEW 산출물 (Rev 5, /plan-eng-review)

### NOT in scope (고려했으나 제외)

- **rrule(RFC5545) 채택** — 단일 전역 스프린트엔 과잉. 직접 구현+DST 단위테스트로 충분(P11).
- **P6 캐시 feature-flag 킬스위치** — 채택 안 함(결정 큐 persist 제외 + git revert로 충분). 재검토는 P6 brainstorm.
- **P4 스킬 스키마 project scope(option A)** — 0013 SSOT 재오픈이라 제외(표시 그룹핑만).
- **에이전트 바 가로 스크롤** — 개수 상한+'+N' 선택으로 제외.
- **다중 스프린트/이력 테이블** — v1 단일 전역(app_config)로 충분, YAGNI.
- **캘린더 drawer 내 일정 생성** — 읽기 전용 보기로 한정(기존 등록 모달과 분리).

### What already exists (재사용 — 재구축 금지)

- P8 enrich-all 게이트: `CaptureBoard.tsx:240-256` (이미 awaiting_approval) → 표시 위치만 이전.
- per-machine KV: `app_config`(migration 0014) → P10b 이름/P11 스프린트 설정.
- 데이터 캐시: `@tanstack/react-query` 설치됨 → P6는 persist + Rust TTL만 추가.
- cmux 워크스페이스 데이터: `lib/query/cmux.ts` → P10a는 렌더만(백엔드 추가 불필요).
- 캘린더 fetch: `commands/calendar.rs`(단, 일 단위) → P7은 range 커맨드 추가.
- 에이전트 바 width 성장/진행 fill: `AgentStatusBar.tsx:62-77` → P10a 확장.
- 테스트 인프라: vitest(`nav.test.ts`) + `cargo test` → 순수함수 unit 테스트 가능.

### Failure modes (신규 코드경로별 1개 + 테스트/에러처리/가시성)

| 경로            | 실패 양상                   | 테스트       | 에러처리                       | 가시성          | 비고            |
| --------------- | --------------------------- | ------------ | ------------------------------ | --------------- | --------------- |
| P6 persist      | stale 데이터로 사람 오판    | unit(만료)   | 결정큐 persist 제외            | 표시            | 제외로 차단     |
| P6 TTL          | 캐시-fresh 불일치(escalate) | unit         | escalate 경로 캐시 미소비      | —               | 펜스            |
| P8 키워드매칭   | 오매칭으로 잘못된 긴급도    | unit(픽스처) | suggested\_\*만, 자동이동 없음 | 모달서 사람수정 | #1 안전         |
| P11 경계계산    | DST/타임존 오류             | unit(DST)    | —                              | 카운트다운      | 직접구현 위험점 |
| P10a 세션열거   | 워크스페이스 과다 → 바 넘침 | unit(cap)    | 개수상한+'+N'                  | 바              | 차단            |
| P1 프로젝트매칭 | 잘못된 프로젝트로 등록      | —            | 선택모달+프로젝트명 에러       | 모달            | 사람선택        |

**critical gap(테스트X + 에러처리X + silent): 없음.**

### Worktree 병렬화 전략

**Sequential implementation by design.** 병렬 worktree 격리가 서로/dev로 누수된 전례가 있어
금지(메모리). 페이즈는 순차 1-PR. 의존성(P6→P7→P8/P9, P10a/P11→P5)도 순차를 강제.
→ "병렬화 기회 없음(의도적). 순차 ralph 루프."

---

## 디자인 명세 (plan-design-review, Rev 6)

> 시각 정본은 **DESIGN.md** 확장분(App Surface — Agent Bar · Header Timer · Calendar Drawer ·
> Enrich Panel). 각 UI 페이즈는 그 컴포넌트 스펙을 따른다. 아래는 플랜 레벨 결정 + 상태 매트릭스.

### 디자인 결정 (사용자 확정)

- **상단 크롬**: 스프린트 타이머는 **브랜드 헤더("Work Radar / …") 우측 존**. 에이전트 바는 별도 상주 스트립(분리).
- **캘린더**: **우측 슬라이드 드로어**(<720px 하단 시트).
- **디자인 SSOT**: **DESIGN.md 확장**(신규 5표면 컴포넌트 스펙 추가 완료).
- **P8 결과**: **보드 내 인라인 리뷰 패널**(오버레이 아님).

### 인터랙션 상태 매트릭스 (신규 표면 — 구현 시 전부 충족)

| 표면                     | loading            | empty                        | error              | 특수                                   |
| ------------------------ | ------------------ | ---------------------------- | ------------------ | -------------------------------------- |
| agent-status-bar (P10)   | —                  | `Agents · idle` pill         | 박스 error 색+라벨 | working 백필 / '+N' 오버플로           |
| sprint-timer (P11)       | —                  | `스프린트 설정` 링크(미설정) | —                  | **overdue=Coral+`지남`**               |
| calendar-drawer (P7)     | 스켈레톤 행        | "이 날짜 일정 없음"+맥락     | 재시도             | **OAuth 미연결=연결 버튼**             |
| enrich-review-panel (P8) | 진행 표시(바 연동) | "제안 없음"                  | 재시도             | partial=행 스트리밍, 사람 수정 후 적용 |
| Cmd+K 스킬(P4)           | —                  | "스킬 없음"                  | —                  | 현재 프로젝트 우선 그룹핑              |
| Today(P9)                | —                  | OAuth 미연결 안내            | —                  | < > 날짜 네비                          |

### a11y/반응형

- 모든 상태 **색+라벨 병기**(DESIGN 전역). 포커스=Focus Blue. 키보드 도달(이름편집/드로어/팰레트). 터치 ≥44px.
- 반응형 분기는 DESIGN.md 신규 표면 "반응형" 절 참조(드로어 <720px 시트, 타이머 축약, 바 이름 숨김).

### 디자인 점수 (초기 → 수정 후)

IA 5→9 · 상태 3→9 · 여정 6→8 · AI슬롭 7→9 · 디자인시스템 4→9 · 반응형/a11y 4→8 · **종합 5→9**.
(목업: OpenAI 키 미설정으로 미생성 — DESIGN.md 토큰 기반 텍스트 스펙으로 대체. 키 추가 시 재생성 가능.)

### NOT in scope (design)

- 캘린더 드로어 내 일정 _생성/편집_(읽기 전용 보기로 한정 — 기존 등록 모달과 분리).
- 에이전트 바 다크 테마/agent-console-card 마케팅 목업 차용(밝은 상주 스트립으로 한정).
- 신규 폰트 번들(DESIGN.md fallback 사용).

---

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status       | Findings                       |
| ------------- | --------------------- | ------------------------------- | ---- | ------------ | ------------------------------ |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 0    | —            | —                              |
| Codex Review  | `/codex review`       | Independent 2nd opinion         | 0    | —            | —                              |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 1    | CLEAR (PLAN) | 10 issues, 0 critical gaps     |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 1    | CLEAR (FULL) | score 5/10 → 9/10, 4 decisions |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       | 0    | —            | —                              |

- **사전 리뷰**: 이 플랜은 oh-my-claudecode Planner→Architect(SOUND-WITH-CHANGES)→Critic(APPROVE) 합의를 통과 후 gstack eng+design review.
- **UNRESOLVED:** 0 (eng 4 + design 4 결정 모두 응답됨).
- **VERDICT:** ENG + DESIGN CLEARED — ready to implement. DESIGN.md에 신규 5표면 스펙 추가됨.
