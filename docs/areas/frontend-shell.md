
# Frontend — App Shell (Views, Settings, Hooks, Queries)

보드(`frontend-board.md`)·UI 프리미티브(`shadcn-migration.md`)·뉴스(`news-feature.md`)를
제외한 프런트 표면. 단일 창, state-driven 뷰(라우터 없음).

## 뷰 카탈로그

`src/store.ts`의 `view` 값으로 전환:

| view             | 컴포넌트                  | 책임                                                           |
| ---------------- | ------------------------- | -------------------------------------------------------------- |
| board            | `CaptureBoard.tsx`        | 캡처 보드 (frontend-board.md)                                  |
| settings         | `SettingsView.tsx`        | 프로젝트·토큰·캘린더·뉴스·키맵·알림·Hermes                     |
| pr               | `PrRadarView.tsx`         | PR Radar (DISPLAY-ONLY — escalation 제거)                      |
| wt               | `WorktreeView.tsx`        | Worktree + Diff Viewer (Phase 5)                               |
| jobs             | `JobsView.tsx`            | Agent Run / Acceptance 게이트 / kill switch                    |
| today            | `TodayView.tsx`           | Today 운영 뷰 (Phase 11)                                       |
| tl               | `TimelineView.tsx`        | 신호/승격/이벤트 시간축                                        |
| wk               | `WeeklyView.tsx`          | 주간 집계                                                      |
| retro            | `RetroView.tsx`           | 회고 (Phase 17)                                                |
| skills           | `SkillsView.tsx`          | 스킬 레지스트리                                                |
| hm               | `HermesView.tsx`          | Hermes/메신저 surface                                          |
| routinetrack     | `RoutineTrackingView.tsx` | 루틴 트래킹 차트                                               |

상주 표면(뷰와 독립):

- `AgentStatusBar.tsx` — 상단 에이전트 박스 (bespoke, 강제 변환 금지)
- `SprintTimer.tsx` — 헤더 카운트다운 (Wave 1.3 shadcn 변환 완료)
- `CommandPalette.tsx` — cmdk 팔레트 (변경 시 신중)
- `ToastHost.tsx` — `AppError` action/retry 배선
- `ErrorBoundary.tsx` — React boundary (main.tsx 마운트)

## 라우팅

라우터 없음. `src/lib/nav.ts` + `useViewShortcuts.ts`(`Cmd+,`/`Cmd+K`/`Cmd+←/→`)로 view
전환. nav-history는 `src/lib/query/nav.ts`.

## TanStack Query 레이어 (`src/lib/query/`)

도메인별 분리: agents, agentsConfig, calendar, client, cmux, hermes, nav, news, notion,
projects, prRadar, retro, routines, scheduler, signals, skills, sprint, today, tokens,
worktree.

- `client.ts` = `IpcError`(AppError 보유), unwrap throw, 전역 QueryCache `onError`에서
  retryable refetch 배선.
- `persist.ts` = react-query persist(인 메모리 + storage). 하이브리드 캐싱(moka TTL은 백엔드).
- mutation 후 `invalidateQueries` — 도메인별 키 컨벤션 일관.

## State (`src/store.ts`)

Zustand. `view`, modal/picker 상태, agent 이름 persist.

## PR Radar 제약 (재도입 금지)

settings-refactor B(2026-05-24)에서 결정:

- **PR Radar는 표시 전용** — escalation 0, CI-failure notification 제거.
- `ticket_key_pattern` 컬럼/필드 GONE (migration 0015). 다시 만들지 말 것.
- `regex` dep 제거됨.
- `auto_resolve` 유지 (legacy escalated cleanup, status만 전이).
- `PrRadarItem.escalated`(always-false dead field) 제거됨.
  단 live `TriageOutcome.escalated`(triage Q1 escalate 결과, `PrRadarView.tsx` `out.escalated`)는 **유지**.

## Settings 패널 (`src/components/settings/`)

- `AddProjectForm.tsx`, `AddRepoForm.tsx`, `ProjectCard.tsx`
- `TokenRow.tsx` — 토큰 입력. `type="password"`, 로컬 useState만, 저장 후 비움. 토큰을
  query/zustand 캐시에 저장 금지.
- `GoogleCalendarBlock.tsx` — OAuth 연결 + 다중 캘린더 선택 (Phase 10).
- `HermesBridgeBlock.tsx` — 봇 토큰 설정.
- `NotificationSettings.tsx`, `NavigationSettings.tsx`(키캡처 위젯 bespoke), `AgentsPane.tsx`.
- `NewsSourceSettings.tsx` — 카테고리 그룹화, 키워드 필터.
- `SettingsKit.tsx` — 공유 패널 컴포넌트.

## Phase 5 Worktree Diff Viewer

- 4 모드: `working` / `staged` / `vs_base`(3-dot merge-base) / `branch↔branch`.
- **read-only** — 체크아웃·리셋 없음.
- 파일 목록(통계) 먼저, 파일별 hunk 지연 로드. 대용량 diff 가상 스크롤.
- `src/lib/worktreeReview.ts` + 테스트.

## 디자인 토큰

- `src/styles.css`는 CSS import hub만 담당한다. 전역 단일 파일로 새 selector를 추가하지 않는다.
- `src/styles/tokens.css` = Tailwind v4 `@theme` 디자인 토큰 SSOT. `--color-wr-*`, `--radius-*`,
  `--font-*`, motion, elevation/shadow, z-index/overlay, density spacing, graph/diff semantic token을 둔다.
- `src/styles/base.css` = reset, `html/body/#root`, body 기본값, Lucide stroke, selection, scrollbar.
- `src/styles/shared.css` = 진짜 앱 전역 utility와 공통 keyframes만. 특정 뷰/컴포넌트 selector 금지.
- 컴포넌트 CSS는 컴포넌트 옆에 둔다. 예: `src/components/worktree/WorktreeView.css`,
  `src/components/AgentStatusBar.css`, `src/components/news/NewsTicker.css`, `src/components/jobs/JobsView.css`.
  해당 컴포넌트 TSX가 직접 import한다.
- component-local token은 해당 CSS root selector 안에 `--wt-*`, `--asb-*`, `--news-*`, `--jobs-*`처럼 둔다.
  graph lane, 외부 브랜드 색상(news source colors), 좁은 의미의 shadow는 전역 토큰으로 승격하지 않는다.
- Raw value 정책: 전역/공유 CSS에서는 raw hex/rgb/shadow 금지. 컴포넌트 CSS에서는 먼저 local semantic
  token으로 선언하고 selector는 token을 참조한다. 레거시 전역 CSS 파일을 다시 만들지 않는다.
- light 모드 기본 (`index.html`엔 `class="dark"` 없음, color-scheme: light).
- 다크 토큰은 `.dark` override (PR C 2026-05-24). `--color-wr-coral`/`--color-wr-green`은
  override 없음 → on-coral/on-green 텍스트는 non-inverting `--color-wr-on-coral-btn` 사용.

## 분해 가드 — audit 권장 ≠ auto-execute

god-component(LOC ≥ 500)이라도 분해 전 **의존성 그래프**를 먼저 본다. audit이 권장한
"hook으로 추출"이 항상 옳지는 않다(2026-05-26 PR-F-Capture 재평가 결과 — `docs/plans/2026-05-26-harness-and-design-rigor.md` §후행 재평가 노트).

## God Component 분해 기준 — Orchestrator + Domain Sections + Leaves

목표는 atomic design 도입이 아니라 사용자 워크플로우 단위 ownership를 코드 구조에 반영하는 것이다.
`atoms/`, `molecules/` 같은 범용 계층 폴더를 만들지 않는다. 상위 container는 query/mutation/state
orchestration을 유지하고, child는 가능하면 pure props 렌더링만 담당한다. Hook 추출은 props 경계가 안정된 뒤
반복 의존성이 보일 때만 한다.

현재 분해 대상 책임:

- `src/components/worktree/WorktreeView.tsx`: 프로젝트 필터, worktree 선택, review lens/ref 선택, diff query
  orchestration, cleanup/graph drawer 열림 상태를 소유한다. 분해 단위는 Header, Sidebar, Lens/Refs toolbar,
  Review surface, Diff panel처럼 Worktree 검수 워크플로우 이름을 따른다.
- `src/components/jobs/JobsView.tsx`: agent/codex 상태 query, echo/codex/self-check/enrich/triage job mutation,
  polling/kill/acceptance 패널 조립을 소유한다. 카드/controls/proposal panel은 파일 분리 가능하지만 accept/kill/polling
  계약은 container에서 끊기지 않게 한다.
- `src/components/CaptureBoard.tsx`: signal/today/routine/project/calendar query와 mutation, board selection,
  overlay/Esc/drag lifecycle owner다. 초기 분해는 Header, ExecutionRail, BoardOverlays, CaptureToast처럼
  drag/MatrixCanvas/useListReorder 경계를 건드리지 않는 JSX bulk에 한정한다.

분해 회귀 잠금:

- UI 전용 렌더 테스트가 없는 표면은 먼저 기존 unit tests + 렌더 스모크 수준으로 baseline을 잡고 시작한다.
- Worktree/Jobs/CaptureBoard 같은 화면 단위 phase 종료 시 `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`,
  `pnpm build`를 유지한다. Tauri smoke는 화면 단위 종료 시 실행한다.
- CSS class namespace(`.wt-*`, `.jobs-*`, `.cb-*`)는 먼저 유지하고, CSS raw token cleanup은 TSX 분해 직후 별도
  작은 패스로만 진행한다.

분해 채택 기준:

1. **추출 단위의 입력 의존성이 작은가.** 새 훅/컴포넌트가 12+ deps(`state setter`/`ref`/
   `derived value`/`query result`)를 인자로 받아야 한다면 false-positive. LOC만 두 파일로
   분산되고 의존성 그래프는 동일 → 가독성 개선 0(안티패턴).
2. **추출 후 의미가 독립적인가.** `JobsView`의 4 Acceptance 패널(SelfCheck/Enrich/
   BatchEnrich/Triage)처럼 실제로 서로 다른 잡 종류 + 독립 폴링/뮤테이션이면 분해 가치 분명.
   반면 `CaptureBoard`의 핸들러들은 보드 lifecycle/state에 깊이 결합 — 같은 컴포넌트의
   책임이 분산이 아닌 **이동**일 뿐.
3. **분해 대신 sub-effect / sub-component가 맞는가.** keyboard/online-event/calendar-urgency
   같은 effect 응집은 dedicated child component(자체 state) 추출이 hook 추출보다 깨끗할 때가
   많다.

god-component를 분해 못 했다고 done-criteria 미달은 아니다. 안티패턴 분해는 회귀 risk만 키운다.

## ESLint (errors-only 게이트)

- react-hooks v7 추가 룰은 warn으로 강등(35건). 35건 일괄 리팩터 금지(`shell-tooling.md` §7).
- 벤더 디렉터리·`bindings.ts`·`src-tauri`는 ignore.

## 자동 구조 가드

- `pnpm check:frontend-ownership`은 `scripts/check-frontend-ownership.mjs`를 실행한다.
- pre-commit에서 `cargo fmt --check`, `pnpm typecheck` 다음에 실행되어 다음 회귀를 차단한다:
  - `atoms/`, `molecules/`, `organisms/` 폴더 생성
  - `src/styles.css` import-hub 회귀 및 `shared.css`에 component namespace selector 추가
  - Worktree/Jobs/CaptureBoard child leaf로 query orchestration 이동
  - WorktreeView/JobsView/CaptureBoard/MatrixCanvas line-budget 초과
  - MatrixCanvas geometry helper 분리 회귀

## 정본 / 참조

- `src/store.ts` — view enum + 글로벌 state
- `src/lib/nav.ts`, `src/lib/query/nav.ts`
- `src/styles.css` — 토큰 정본
- `docs/decisions.md` § settings-refactor / shadcn migration
- `docs/architecture.md` §8 (Worktree Diff)
