
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

- `src/styles.css` `@theme` (`--color-wr-*`, `--radius-*`, `--font-*`).
- light 모드 기본 (`index.html`엔 `class="dark"` 없음, color-scheme: light).
- 다크 토큰은 `.dark` override (PR C 2026-05-24). `--color-wr-coral`/`--color-wr-green`은
  override 없음 → on-coral/on-green 텍스트는 non-inverting `--color-wr-on-coral-btn` 사용.

## 분해 가드 — audit 권장 ≠ auto-execute

god-component(LOC ≥ 500)이라도 분해 전 **의존성 그래프**를 먼저 본다. audit이 권장한
"hook으로 추출"이 항상 옳지는 않다(2026-05-26 PR-F-Capture 재평가 결과 — `docs/plans/2026-05-26-harness-and-design-rigor.md` §후행 재평가 노트).

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

## 정본 / 참조

- `src/store.ts` — view enum + 글로벌 state
- `src/lib/nav.ts`, `src/lib/query/nav.ts`
- `src/styles.css` — 토큰 정본
- `docs/decisions.md` § settings-refactor / shadcn migration
- `docs/architecture.md` §8 (Worktree Diff)
