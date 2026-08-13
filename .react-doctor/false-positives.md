# React Doctor — false-positive 패턴

각 항목은 `react-doctor/<rule>` 키로 시작하고, 그 아래 한 줄로 코드 모양과 사유를
적는다. 워커는 텍스트 매칭으로 발화 항목을 거른다.

## `react-doctor/query-mutation-missing-invalidation`

- mutation `onSuccess`가 `useInvalidate()` (src/lib/query/client.ts:109, 반환
  `{ signals, today, routines }`) 또는 `useInvalidateRetro()` (src/lib/query/retro.ts:19)
  헬퍼 메서드(`inv.signals()`, `inv.today()`, `inv.routines()`, `inv()`)를 호출하는 패턴.
  헬퍼는 내부에서 `qc.invalidateQueries`를 부르지만 워커가 cross-file indirection을
  따라가지 않아 발화 — 의도된 invalidation이 있음. 헬퍼는 `todayOverview` 같은 파생
  집계 동봉 invariant를 강제하므로 인라인으로 풀면 코드 헬스가 회귀함.
- mutation이 의도적으로 캐시 무변경(read-only ping / detect / cancel / focus / queue
  insert). 패턴: `usePing*`, `useDetect*`, `useCancel*`, `useFocus*`,
  `useSchedule*Notification` — 갱신할 쿼리 자체가 없음.

## `react-doctor/client-localstorage-no-version`

- `CommandPalette.tsx`의 최근 명령과 `SkillsView.tsx`의 환경 순서는 문자열 배열만 저장하는
  표시 전용 값이다. 두 reader 모두 JSON을 `unknown`으로 읽고 `Array.isArray` + 문자열 필터 +
  `try/catch`로 낯선/손상된 shape를 빈 배열로 격리하므로 진단이 경고하는 앱 크래시 경로가 없다.

## `react-doctor/server-sequential-independent-await`

- `governance/src/orchestrator/core.ts`의 `autoAccept` → `autoDispatch`는 반환값 의존성 대신 이벤트
  로그 의존성이 있다. 앞 호출이 acceptance 이벤트를 쓴 뒤 뒤 호출이 최신 로그를 읽어 dispatch하므로
  병렬화하면 gate 순서와 결정 레일을 깨뜨린다.

## `react-doctor/no-pass-data-to-parent`

- `src/lib/query/agents.ts`의 effect는 자식 데이터를 부모 콜백으로 올리지 않는다. terminal run의
  마지막 로그 tail을 보장하려고 TanStack Query 캐시를 1회 invalidate하는 폴링 경계다.

## `deslop/unused-file`

- `governance/bridge/boule-mcp.mjs`는 import entry가 아니라 Python bridge와 운영 runbook이
  `node bridge/boule-mcp.mjs <tool>`로 spawn하는 one-shot MCP CLI다. 정적 import graph에 없지만
  실제 운영 진입점이므로 삭제하면 governance round-trip이 깨진다.

## `react-doctor/design-no-three-period-ellipsis`

- JSX 본문의 `"...HEAD"` / `"base...HEAD"` 처럼 git 3-dot diff 문법 표기. 텍스트
  ellipsis가 아니므로 `…`로 치환하면 의미가 깨진다.

## `react-doctor/js-set-map-lookups`

- `lanes.indexOf(...)` in `src/lib/worktreeReview.ts` — 매 iteration마다 push/pop/null
  swap으로 변형되는 작은 lanes 배열(보통 < 10) 위 lookup. Set으로 바꾸면 매 iter
  재구축 비용이 더 큼.

## `react-doctor/no-aria-hidden-on-focusable`

- `aria-hidden`이 `tabIndex={-1}`과 같은 조건으로 토글되는 경우 (예: `src/components/news/NewsTicker.tsx`)
  — 포커스 흐름과 일관, 키보드 사용자가 우회하도록 의도됨.

## `react-doctor/no-flush-sync`

- `src/App.tsx:3` import + `src/App.tsx:105` `flushSync(() => { setViewSnapshot(...); goTo(target); })` — 뷰 전환 시
  직전 `shell.innerHTML` 스냅샷이 새 view로 교체되기 **전에** 캡처돼야 슬라이드 트랜지션이
  성립. `startTransition`로 바꾸면 deferred render가 되어 snapshot이 새 트리로 덮임. by-design.

## `react-doctor/no-render-in-render`

- `src/App.tsx:207` `{renderView(view)}` — `renderView`는 이미 모듈 스코프(`src/App.tsx:43`)
  순수 매핑 함수. 워커가 JSX 안의 함수 호출 텍스트만 보고 발화. 인라인 컴포넌트가 아님.

## `react-doctor/no-danger`

- `src/App.tsx:215` `dangerouslySetInnerHTML={{ __html: viewSnapshot.html }}` —
  `viewSnapshot.html`은 `src/App.tsx:101-109`에서 직전 렌더 결과를 `shell.innerHTML`로
  캡처한 자기 자신의 DOM 문자열. 외부 입력 0 (same-origin app DOM 재투영) → XSS surface
  없음. 뷰 전환 슬라이드 전용.

## `react-doctor/rerender-functional-setstate`

- `src/lib/usePaneSize.ts:89,94` `setSize(size - 24)` — 여기 `setSize`는 React useState
  setter가 **아니라** 다음 값을 return하는 사용자 정의 함수(`const next = setSize(...)`).
  workspace 패널 사이즈 컨트롤러 — 패턴이 의도적.

## `react-doctor/prefer-tag-over-role`

- round 4: div + `role="checkbox"` 두 사이트(RoutinesPanel/TodayRail)는 radix
  `CheckboxPrimitive.Root` (shadcn `<Checkbox>` wrapper)로 정식 마이그레이션 — 디자인
  토큰(`.cb-check` opacity 패턴)은 `forceMountIndicator` + custom indicator slot으로 유지.
- 기타 `prefer-tag-over-role` (img / section / output / address / li / menu / th / td) —
  CommitGraphDrawer grid, UnscheduledTray, EnrichReviewPanel 등은 DESIGN.md 스타일 토큰
  - radix wrapper와 묶여 있어 element rename이 시각/상호작용 회귀를 부를 수 있음. 사이트별
    visual diff + DESIGN.md 토큰 검토 후 별도 a11y PR(`prefer-tag-over-role` 일괄)로 분리.

## `react-doctor/control-has-associated-label`

- round 4 form a11y batch에서 33/35 정리(`htmlFor`/`id` + `useId`, `aria-label`, `<label>`
  → `<div>` 헤더 분리). 잔존 2건은 FP:
  - `settings/LifeWheelTagSettings.tsx:103` — `Field` 컴포넌트(SettingsKit.tsx)가 내부에서
    `<label htmlFor>`를 렌더하지만 워커가 component boundary를 따라가지 못함.
  - `settings/AgentsPane.tsx:264` — `<datalist><option>...` 패턴 — `<option>`은 datalist의
    추천값일 뿐 직접 라벨이 필요한 컨트롤이 아님(W3C 명세 외).

## `react-doctor/exhaustive-deps`

- `useEffect` deps 의도적 생략(mount-only 효과 / mutation 콜백 안정성 보장 / unrelated
  re-run 차단). 각 사이트는 변경 시 영향 분석이 필요해 일괄 자동 픽스 불가.
- `src/components/board/MatrixCanvas.tsx` layout/resize effects — imperative post-it geometry owner.
  `signalsRef`/`cbRef` are updated in layout effect so pointer/resize handlers keep current data without
  rebinding drag listeners; adding every helper/function dep causes drag/layout churn.
- `src/components/worktree/WorktreeDiffText.tsx` Shiki tokenize effect — `codeIndices` is intentionally
  referentially stable through the `parsed` memo chain because it is an effect dependency. Removing memoization
  recreates fresh deps and can repeatedly retokenize large diffs.

## `react-doctor/no-react19-deprecated-apis`

- `.claude/skills/tailwind-v4-shadcn/SKILL.md:235`,
  `.codex/skills/tailwind-v4-shadcn/SKILL.md:235`,
  `.claude/skills/tailwind-v4-shadcn/references/dark-mode.md:102`,
  `.codex/skills/tailwind-v4-shadcn/references/dark-mode.md:102` —
  스킬 문서의 fenced 예제 코드(`ReactDOM.createRoot(...).render(...)`). 앱 코드가
  아니고 빌드/번들 대상 외이며, 스킬 배포용 템플릿 호환성 설명으로 남긴다.

## `react-doctor/no-array-index-key`, `no-array-index-as-key`

- 데이터 자체가 stable ID 없는 agent 응답 string list (`selfChecks`, `suggestedFixes`,
  `screenshotsNeeded`, `migrationNotes`) — content를 key로 써도 중복 가능.
- diff block/line/token (`src/components/worktree/WorktreeDiffText.tsx:113-122`) —
  `parsed`에서 매 렌더 통째로 재계산되는 ephemeral diff 뷰. 블록/줄/token에는 서버 stable ID가
  없고 순서 자체가 diff 좌표라 인덱스 key가 reconcile 정확성에 영향 없음.

## `react-doctor/js-combine-iterations`

- `.filter().map()` / `.map().filter()` — N이 작고 두 단계가 의미를 분리해 표현(필터 의도
  - 변환 의도). 단일 `for...of`로 합치면 가독성 손해가 perf 이득보다 큼.

## `react-doctor/no-derived-useState`

- **canonical React 18+ pattern** (https://react.dev/learn/you-might-not-need-an-effect#storing-information-from-previous-renders):
  `const [prev, setPrev] = useState(propX); if (propX !== prev) setPrev(propX);` —
  prop이 바뀔 때 reseed/reset이 필요한 경우 공식 권장 패턴. "derive during render"
  대안은 reset 시점을 표현 못함. ProjectPickerModal, CalendarEventModal, AgentsPane,
  AgentStatusBar, MatrixCanvas, SkillsView 모두 이 패턴 사용.
- `src/components/hermes/HermesChatLog.tsx` `prevEmpty` — empty→non-empty transition detection controls
  the one-shot Hermes wordmark exit pulse. An effect-based mirror can race with streaming message updates and
  clear the exit timer; the render-time previous-value pattern is the intentional reset boundary.

## `react-doctor/no-derived-state`

- Same protected previous-render comparison family as `no-derived-useState`: the state is not cached derived
  display data, it is a transition/reset sentinel. Rewriting these sites as effects introduces an extra stale
  render or races with unmount/remount animations.

## `react-doctor/no-cascading-set-state`

- `src/components/hermes/HermesChatLog.tsx` empty-state transition — the paired `setPrevEmpty` +
  `setExiting(true)` occurs only when `messages.length === 0` flips. It intentionally avoids a post-render
  effect cascade that previously allowed the empty wordmark to stick during restored/streaming sessions.

## `react-doctor/rerender-state-only-in-handlers`

- `prevState`/`seeded`/`seededFrom` 패턴 — JSX return 밖이지만 **render 본문의
  change-detection 조건문**(`if (state !== prevState) setPrevState(state)`)에서 read.
  워커가 return JSX만 검사. `useRef`로 바꾸면 render 중 mutation = React 안티패턴.
  no-derived-useState와 같은 사이트군.

## `react-doctor/prefer-use-effect-event`

- `useEffectEvent`는 React 19에서도 **experimental API** (`React.experimental_useEffectEvent`).
  stable React API만 쓰는 코드에서 적용 불가. `addEventListener` + 안정 ref 패턴이
  현 시점 best practice.

## `react-doctor/prefer-useReducer`

- "5+ useState" 단순 카운트 휴리스틱. 무관한 폼 필드(Settings/AgentsPane/
  NavigationSettings/GoogleAccountBlock/WorktreeView)는 reducer 통합이 결합도를 오히려
  높임. 진짜 관련 state는 이미 단일 객체로 묶여 있음.
- `src/components/board/RoutineForm.tsx` — fields are independent HTML form controls seeded once by parent
  remount key. A reducer would centralize unrelated setters without adding invariant protection.
- `src/components/settings/AgentsPane.tsx` `AgentPromptConfigRow` — independent draft fields map 1:1 to
  backend config fields; the dirty check is the only cohesive projection.
- `src/components/worktree/WorktreeView.tsx` — state groups are workflow controls (project filter, selected
  worktree, review lens/refs, selected diff, drawers). Collapsing them into one reducer would widen unrelated
  update paths inside the query orchestration owner.

## `react-doctor/no-event-handler`

- `.claude/skills/` / `.codex/skills/` 템플릿 4건 — 앱 외부.
- 앱 코드 2건은 `useEffect`가 진짜 side-effect(`mutation.reset()`, `input.focus()`)
  실행 — explicit comment + `// eslint-disable-next-line` 동봉.

## `react-doctor/no-multi-comp`

- `src/components/ui/select.tsx:10,31,56` (`SelectTrigger`/`SelectContent`/`SelectItem`) —
  shadcn primitive convention(한 파일 = primitive family)이며
  `docs/areas/shadcn-migration.md`가 `src/components/ui/**`를 primitive family로 관리한다.
  `SelectContent`는 overlay-stack `data-wr-overlay-open` 계약도 함께 보유하므로 분리하면
  shadcn convention과 Esc 계약 추적성이 회귀한다.

## `react-doctor/react-compiler-no-manual-memoization`

- `src/App.tsx:86` `navigateView` — `registerKeydown(..., navigateView)` effect deps와
  `CmdKnob` prop identity에 연결된 shell navigation chokepoint. React Compiler가 켜져 있어도
  정적 분석기/bailout 환경에서 키다운 버스 재구독을 피하려는 명시 identity 보존.
- `src/components/worktree/WorktreeDiffText.tsx:50-71` `allLines`/`parsed`/
  `codeText+codeIndices` chain — `codeIndices`가 Shiki tokenize effect deps
  (`src/components/worktree/WorktreeDiffText.tsx:82-100`)로 들어간다. 주석처럼 compiler bailout 또는
  정적 분석기 `no-effect-with-fresh-deps` 안전을 위해 referential identity가 의도된 수동 메모.

## `react-doctor/no-giant-component`

- `CaptureBoard` 491L, `MatrixCanvas` 423L, `RoutinesPanel` 304L — soft heuristic, 한
  파일 안에서도 sub-section이 분리돼 있음. 파일 분할은 별도 관심사 PR.

## `react-doctor/no-static-element-interactions`

- `CalendarView.tsx:87,140` — round 3에서 `role={cb?"button":undefined}` **조건부** role
  추가 (cb 없을 때 div는 클릭 핸들러도 없음). 워커가 조건부 role을 검출 못함.
- `MatrixCanvas.tsx:393` — post-it 카드 `<div>`는 `@dnd-kit` drag source. role/tabIndex
  추가가 drag-and-drop semantics와 충돌.

## `react-doctor/prefer-html-dialog`

- `src/components/board/CalendarDrawer.tsx` `<aside role="dialog">` — protected bespoke non-modal
  side/bottom sheet. It uses capture-phase Esc + `stopPropagation` to prevent App window-hide, restores trigger
  focus, and remains usable alongside the board. Replacing it with native `<dialog>` or radix Dialog breaks the
  responsive side-sheet/non-modal contract documented in `docs/areas/frontend-board.md` and
  `docs/areas/shadcn-migration.md`.

## `react-doctor/rendering-hydration-mismatch-time`

- This Tauri/Vite app has no SSR hydration path. `src/components/today/useTimelineScroll.ts` reads `new Date()`
  inside `useLayoutEffect` only to center the scroll position after mount; it does not render time-dependent
  markup.
- `src/components/control-room/ControlRoomView.tsx` seeds `nowMs` with a lazy `Date.now()` initializer and
  updates it only on explicit refresh. The rendered relative stamp is client-only operational chrome, not
  server-rendered content.

## `react-doctor/no-noninteractive-element-interactions`

- round 4: `SprintTimer.tsx`의 `<section onKeyDown>` 는 `<div role="dialog">`로 정정.

## `deslop/unused-dev-dependency`

- `@tauri-apps/cli` — `node_modules/.bin/tauri` 바이너리 제공원. `scripts/tauri-wrapper.sh`가
  fallback으로 참조하므로 코드 import가 없어도 제거 불가.
