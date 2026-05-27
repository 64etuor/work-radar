# shadcn 앱 전면 적용 — 실행 플랜 (ralph-ready, 2026-05-24)

> **이 문서만 읽고도** 다음 세션/ralph가 컨텍스트 없이 진행할 수 있게 작성. 정본 규칙은
> `AGENTS.md`(working agreement) + `PLAN.md §1`(INVARIANTS) + `DESIGN.md`(시각 정본).
> 명령은 `docs/reference/commands.md`. 이 문서는 *남은 작업 + 슬라이스 + 실행 프로토콜*만 담는다.
>
> **rev2 (ralplan consensus: architect SOUND-WITH-CHANGES + critic ITERATE 반영).** 핵심 변경:
> PR 0가 raw 프리미티브가 아니라 **상호작용 계약 래퍼**(Esc/focus/portal)를 제공, 모달/메뉴 슬라이스에
> **Playwright 스모크 hard gate** 추가, 슬라이스별 롤백·공간형 객관 기준·pre-mortem 추가.

## 0. 배경 (현황 실측, 2026-05-24)

- **shadcn 적용 = 사실상 `settings/`만.** `@/components/ui/button` import가 `settings/*` + `SettingsView` + `poc`에만 존재.
- **앱 본체(보드·PR Radar·Jobs·Today·Timeline·Weekly·Worktree·Retro·Hermes·Skills 등)는 raw `<button>/<input>/<select>/<textarea>` + 커스텀 `styles.css`(5724줄)**로 구성.
- **현재 `src/components/ui/`**: `badge·button·card·command·input·label·select·switch` (+`cn`). **없음**: `dialog·dropdown-menu·tooltip·tabs·checkbox·textarea`(+필요 시 `popover·toggle-group·separator·scroll-area`).
- `CommandPalette`는 이미 `cmdk`(`command.tsx`) 기반 → 그대로 둔다.

## 0.5 결정 (사용자 승인 완료)

- **범위 = 프리미티브 이전 + 공간형 토큰 정렬 패스.** 공간형 고유 UI(아이젠하워 2×2 보드·드래그 카드·Today 레일·Worktree diff 뷰어)의 **레이아웃 구조/인터랙션은 변경 금지**, 여백·타이포·색만 DESIGN.md 토큰으로 정렬.
- **슬라이싱 = Foundation → 뷰별(한 PR = 한 뷰).**
- **ToastHost = 커스텀 유지** (react-query `onError`→retry 배선 보존, sonner 이전 안 함).
- **비-목표**: 공간형 레이아웃 구조 재설계, 보드/diff 인터랙션 변경, 결정 레일/IPC/쿼리 로직 변경(행위 100% 보존), 신규 기능.

## 0.6 ⚠️ 상호작용 계약 (consensus CRITICAL — 모든 모달/메뉴 작업의 전제)

이 앱은 **상호작용 동작을 마크업/DOM 관례에 인코딩**해 둔다. 정적 게이트(typecheck/lint/build/bindings)는 이 계약 위반을 **검출하지 못한다**. raw shadcn으로 갈아끼우면 컴파일은 통과하면서 동작이 깨진다.

1. **Esc → 창 숨김 계약.** `App.tsx:57-69`가 **bubble-phase native** `window` keydown으로 Esc 시 `getCurrentWindow().hide()`. 기존 모달은 전부 **capture-phase native 리스너 + `stopPropagation`**으로 방어(`src/components/board/ProjectPickerModal.tsx:44`, `src/components/SprintTimer.tsx:124`, `src/components/AgentStatusBar.tsx:360,369` — 코드 주석이 실패모드 명시: "synthetic stopPropagation은 native window 리스너를 못 막음"). radix Dialog의 `onEscapeKeyDown`은 synthetic/bubble → native capture 셸 리스너를 **못 막음** → **Esc가 모달을 닫으며 창 전체를 숨김**.
2. **`.cb-card-menu` 셸 커플링.** `App.tsx:63`이 `.cb-card-menu`를 query해 "메뉴 열림 → 창 유지"를 판단. `src/components/board/CardMenu.tsx:66`이 그 클래스를 인라인 렌더. radix DropdownMenu는 portal로 클래스를 트리 밖으로 옮김 → 셸 분기 무력화.
3. **focus 계약.** 기존 모달은 특정 필드에 `autoFocus`(`src/components/board/ProjectPickerModal.tsx:73`, `src/components/board/CalendarEventModal.tsx:184`, `src/components/board/CapturePanel.tsx:59`). radix Dialog는 focus 관리/트리거 복원이 달라 충돌 가능.

→ **해결책 = PR 0가 이 계약을 인코딩한 래퍼를 한 번에 제공**(아래 PR 0). 슬라이스마다 재발견하지 않는다.

---

## 1. 실행 프로토콜 (모든 슬라이스 공통 — 반드시 지킬 것)

### 1.1 브랜치/머지 (dev 오염 금지)

- **슬라이스 1개 = 브랜치 1개.** `git checkout -b refactor/shadcn-<slug>` (예: `refactor/shadcn-jobs-view`).
- 순서: 구현 → **검증(1.3)** → `dev` `--ff-only` 머지 → `git push origin dev` → 브랜치 삭제.
- `dev`는 **green만 수령.** `main` 직접 push 금지(husky pre-push 차단).
- **병렬 worktree 에이전트 금지** — 오염 전례. 위임은 **단일·순차 executor**, 오케스트레이터가 독립 재검증.
- **슬라이스별 롤백**: 머지 후 회귀로 판명되면 `git revert`로 그 슬라이스 커밋(들)을 되돌림(--ff-only라 머지 커밋 없음 — 한 PR=한 뷰 = 원자적 revert 단위). 다음 슬라이스는 revert 이후 base에서 분기.

### 1.2 환경 함정 (실측)

- cargo가 기본 PATH에 없음 → cargo/커밋 전 `export PATH="$HOME/.cargo/bin:$PATH"` (husky pre-commit = `cargo fmt --check` + `pnpm typecheck`).
- rtk 래핑 cargo/grep 출력 부정확 → `rtk proxy ...`로 실행, 파일은 Read 도구로 교차검증. 파이프는 파일 리다이렉트 후 Read.
- 위임 후 늦은 쓰기 주의 → 커밋 직전 `git status --short` 확인.
- lint 스크립트 존재: `pnpm lint`(=`eslint .`). (`docs/reference/commands.md`의 "lint 스크립트 없음"은 stale — MN1로 갱신.)

### 1.3 검증 (체크박스 = 실행 증거, prose 우회 금지)

- **`git diff --exit-code src/bindings.ts` = 빈값** (전부 FE-only — IPC 표면 무변경 증명). **`bindings.ts`는 이 플랜 전체에서 무변경**(불변). 비면 잘못 건드린 것.
- `pnpm typecheck`(0) · `pnpm lint`(신규 **에러** 0; react-hooks 경고는 기존 정책대로 비차단) · `pnpm build` green.
- **모달/메뉴 슬라이스(3·5·6·7·8·23) = cmux 브라우저 인터랙션 스모크 필수(hard gate)**: (a) 모달/메뉴 열기, (b) Esc 1회 → 오버레이만 닫힘 **AND 창 유지(`window.hide` 미호출)**, (c) 트리거 포커스 복원, (d) 메뉴는 보드 카드 selection 불변. **스모크 통과 증거 없으면 머지 금지.** (정적 게이트가 Esc/portal/focus 회귀를 못 잡으므로 자율 루프와 양립시키는 게이트.)
  - **cmux 스모크 메커니즘(검증됨 2026-05-24)**: `pnpm dev`(vite, :1420)에 cmux 브라우저로 접속 → `cmux browser addinitscript`로 tauri 스텁+hide 스파이 주입(`__TAURI_INTERNALS__.invoke`가 `hide` 호출을 `window.__omcHide`에 기록) → reload → 모달 트리거 click(eval) → `cmux browser press Escape` → `eval`로 `{hideCalls: window.__omcHide(빈배열), dialogRole(false)}` 단언. 실 모달에서 open `[role=dialog]`=true / Esc 후 false·hideCalls=[] 재현 완료. raw radix Dialog면 hideCalls 비지 않음 → 스모크 실패로 회귀 검출.
- **시각 QA = cmux 브라우저 스크린샷**(`cmux browser screenshot --out`, vite dev 대상). 헤드리스로 뷰 렌더 확인 가능(앱이 IPC 미가용이어도 셸·레이아웃 렌더; tauri 스텁 주입 시 toast 노이즈 제거). 데이터 의존 시각은 여전히 사용자 관찰 보조.
- 행위 보존: 핸들러/쿼리/IPC 무변경, className·마크업·프리미티브 컴포넌트만 교체.
- **결정 레일 인접(보드 분류·accept/promote·Acceptance 게이트 버튼) 변경은 self-approve 금지** → `code-reviewer` 또는 `critic` 별도 패스로 INVARIANT #1/#2 + **Esc/focus/selection 불변** 확인.
- 각 슬라이스 머지 시 `docs/decisions.md`에 한 줄 + 의도적 시각 변화 기록.

### 1.4 토큰 정렬 규칙

- 색·타이포·라운드·스페이싱은 Tailwind v4 `@theme` 토큰만. **하드코딩 hex 금지**(PR C 선례). 다크는 shadcn 토큰이 `.dark` 자동 적응.
- 라이트 시각은 가능한 한 보존. 불가피한 변화만 의도적으로, decisions에 기록.
- 뷰 슬라이스에서 **이제 dead가 된 그 뷰의 `styles.css` 규칙 제거**(PR D 선례 — 토큰경계 매칭으로 over-deletion 0 증명). styles.css 축소가 부수 목표.

---

## 2. 슬라이스 목록 (순서 = ROI·위험)

> 파일 옆 숫자 = 현재 raw 프리미티브 카운트(2026-05-24 실측). b=button, i=input, s=select, t=textarea, m=모달/오버레이.
> **강제 선행**: 모든 모달/메뉴 슬라이스(3·5·6·7·8·23)는 **PR 0 Dialog/DropdownMenu 래퍼(Esc/focus/marker 계약)** 완료를 전제로 한다.

### PR 0 — Foundation (상호작용 계약 **래퍼** — 강제 선행)

- **추가(raw 아님 — §0.6 계약 인코딩 래퍼)**:
  - `src/components/ui/dialog.tsx` — radix Dialog 위에 (a) 열린 동안 **capture-phase native Escape 인터셉터**가 셸(`App.tsx:57`)보다 먼저 `stopPropagation`(기존 ProjectPickerModal 패턴), (b) 닫힐 때 트리거 포커스 복원 + `autoFocus` 대상 보존.
  - `src/components/ui/dropdown-menu.tsx` — radix DropdownMenu 위에 셸이 감지할 **open 마커**(`.cb-card-menu` 동등 마커 보존 또는 공유 open-count 스토어) 노출 → `App.tsx:63` 커플링 유지.
- **추가(계약 불필요, raw shadcn)**: `tooltip`·`tabs`·`checkbox`·`textarea`.
- **lazy(YAGNI — 소비처 만날 때)**: `popover`·`toggle-group`·`separator`·`scroll-area`. (DESIGN.md가 popover를 요구하지 않고 Wave 1-2 소비처 없음 — critic 확인.)
- **건드리지 않음**: ToastHost(커스텀 유지), CommandPalette(cmdk 유지).
- **Done**: 래퍼 2종 + 표준 4종 추가; typecheck/build green; `bindings.ts` drift 0; **Playwright MCP 스모크로 Esc 계약 증명**(Dialog/DropdownMenu 열기 → Esc → 오버레이만 닫힘·창 유지·포커스 복원); 래퍼가 vanilla shadcn에서 벗어난 점 `decisions.md` 기록.
  - **스모크 구현 메커니즘(cmux, 검증됨)**: `cmux browser`로 `vite dev`(:1420) 접속 → `addinitscript`로 tauri 스텁+`hide` 스파이 주입 → 모달 열고 `press Escape` → `eval`로 `window.__omcHide`(빈배열)·모달 닫힘 단언. §1.3 참조. (Playwright MCP는 tauri webview 미구동이라 불가 — cmux 브라우저로 해결.)

### PR 0.5 — settings 잔여 raw 정리 + commands.md MN1 [tiny]

- `SettingsView`(b3)·`settings/NavigationSettings`(b2)·`settings/TokenRow`(b1)·`settings/kit.tsx`(b1)·`settings/GoogleAccountBlock`(i1)의 잔여 raw 프리미티브 → shadcn.
- **MN1**: `docs/reference/commands.md`의 "lint 스크립트 없음"(21-22·75-76행)을 `pnpm lint`(=`eslint .`) 존재로 갱신.
- **Done**: settings 트리 raw `<button>`/`<input>` 0(grep), commands.md lint 항목 정확, 검증(1.3).

### Wave 1 — 워밍업 (저위험·패턴 검증)

1. **PrRadarView** (b4) — 행 액션 버튼 → `Button`(variant/size). dead `.pr-*` 정리.
2. **AgentStatusBar** (b1, i1) — 인라인 이름 편집 input → `Input`, 버튼 → `Button`. (오버플로는 현 마크업 유지 — popover 불필요.)
3. **SprintTimer** (b8, i2, m1) — 일정 편집 모달 → **PR 0 `Dialog` 래퍼**, 버튼/인풋 → 프리미티브. **모달 슬라이스 → Playwright 스모크 필수.**
4. **ErrorBoundary** (b2) + **Spinner** (표시) — 버튼 → `Button`, Spinner 토큰 정렬.

- **Done(각)**: 해당 뷰 raw 프리미티브 0, dead CSS 제거, 검증(1.3) + (모달이면 스모크) + 육안(사용자 관찰).

### Wave 2 — 모달/메뉴 (PR 0 래퍼 의존 — 전부 Playwright 스모크 hard gate)

5. **CardMenu** (b10) → **PR 0 `dropdown-menu` 래퍼**. **`App.tsx:63` `.cb-card-menu` 셸 커플링을 함께 해결** — 래퍼 open 마커로 App.tsx 무변경이 이상적, 불가 시 App.tsx 편집은 이 슬라이스의 "셸 무변경" 예외로 명시. **주의**: 현재 CardMenu는 Esc 핸들러 없음(바깥 클릭 `pointerdown`만 — `CardMenu.tsx:48-53`) → radix DropdownMenu의 Esc-닫힘은 **신규 동작**(보존 아님), 스모크가 "Esc → 메뉴만 닫힘·창 유지·selection 불변"으로 커버. **결정 레일 인접**(승격/Today/snooze/done/archive) → **code-reviewer 패스 필수**(INVARIANT #1/#2 + Esc/focus/selection 불변).
6. **EnrichModal** (b2, s2, t1, m) → `Dialog`+`Select`+`Textarea`. **suggested-only 유지**(자동 분류 0 — INVARIANT #1).
7. **CalendarEventModal** (b2, i4, s1, t1, m) → `Dialog`+`Input`+`Select`+`Textarea`.
8. **ProjectPickerModal** (b2, s1, m) → `Dialog`+`Select`.
9. **EnrichReviewPanel** (b3, s2) → 인보드 리뷰 프리미티브 교체(suggested-only 유지). **결정 레일 인접 → reviewer 패스.**

### Wave 3 — 대형 리스트

10. **JobsView** (b18, i1, s4, t5) — 잡 제어/필터/프롬프트. **kill/cost cap/Acceptance 게이트 버튼은 행위 보존 + code-reviewer**(INVARIANT #2/#5).
11. **TodayView** (b13) — Today 레일/완료/되돌리기 버튼(로컬 액션 — 행위 보존).
12. **WorktreeView** (b13, i2, s3) — 비교모드 셀렉트/패널 버튼(읽기 전용 #6, diff 레이아웃 토큰만).

### Wave 4 — 보조 뷰

13. **RetroView** (b7) · 14. **TimelineView** (b6) · 15. **WeeklyView** (b1)
14. **HermesView** (b4, i1) · 17. **SkillsView** (b9, i3, s1, t3) · 18. **RoutineTrackingView** (b2)

### Wave 5 — 보드 코어 (THESIS — 가장 신중, 토큰 정렬 위주, §3 객관 기준 적용)

19. **CapturePanel** (b3, i1) — 캡처 입력 → 프리미티브; **개인/업무 세그먼트 = toggle-group(2-state), tabs 아님**(이 슬라이스 직전 toggle-group lazy 추가).
20. **MatrixCanvas** (b2, t1) — **드래그 분류·사분면 로직 절대 무변경**(INVARIANT #1). 토큰 정렬 + 프리미티브 스왑만. TitleEditor Esc-cancel 순서 보존(`MatrixCanvas.tsx:469-480`). **critic 패스.**
21. **TodayRail** (b1) · 22. **RoutinesPanel** (b8, i3) · 23. **CalendarDrawer** (b8, m — Dialog/Drawer 래퍼 + Playwright 스모크)
22. **CaptureBoard** (b1, t1) — 보드 셸 토큰 정렬.

---

## 3. 완료 정의 (전체)

- 전 뷰 raw `<button>/<input>/<select>/<textarea>` → shadcn 프리미티브(공간형 캔버스 제외 영역 0). `rtk proxy grep`으로 잔여 카운트 추적.
- 공간형 UI 토큰 정렬 완료(하드코딩 hex 0 in 대상 영역).
- `styles.css` 축소(dead per-view CSS 제거).
- 매 슬라이스 `bindings.ts` drift 0 · typecheck/lint/build green · (모달/메뉴면 Playwright 스모크) · 육안(사용자 관찰) · decisions 한 줄.
- 결정 레일 인접 슬라이스(5·6·9·10·20)는 code-reviewer/critic ACCEPT.
- **공간형(Wave 5) 슬라이스 객관 기준**: (a) `rtk proxy grep` 하드코딩 hex 0, (b) JSX 구조 diff = className/토큰만 변경(핸들러·DOM 트리·드래그 로직 라인 무변경 — diff 리뷰로 증명), (c) 드래그 슬라이스(MatrixCanvas 20)는 분류/사분면 동작 보존을 Playwright 또는 육안+critic 증거로.

## 4. INVARIANTS 적합성

- **#1 결정 레일**: 시각/프리미티브만 교체, 분류·승격·suggested 로직 무변경. Wave 2·3·5 인접 슬라이스는 reviewer 패스(+Esc/focus/selection 불변)로 잠금.
- **#2 Acceptance 게이트**: accept/promote 버튼 리스킨해도 "accept 전 외부 무변경" 보존.
- **#5 bounds**: Jobs kill/cost cap 버튼 행위 보존.
- **#6 read-only**: Worktree diff 표시 전용 유지.
- 나머지(#3/#4/#7)는 FE 리스킨이라 무관.
- **AGENTS.md**: 한 PR = 한 뷰(한 관심사), 순수 리스킨이라 feature/refactor 비혼합.

## 4.5 Pre-mortem (실패 시나리오 3 + 방어)

1. **Esc/창 회귀 누수**: 래퍼 없이 raw Dialog 사용 → Esc가 창을 숨김, 정적 게이트 통과로 여러 슬라이스 머지 후 발견. → **방어**: PR 0 래퍼 강제 선행 + 모달 슬라이스 Playwright 스모크 hard gate.
2. **App.tsx 셸 커플링 단절**: CardMenu portal로 `.cb-card-menu` 소실 → "메뉴 열림 시 창 유지" 무력화. → **방어**: PR 0 DropdownMenu open 마커 계약 + 슬라이스 5 명시.
3. **토큰 정렬을 빙자한 구조 변경**: Wave 5에서 flex→grid 등으로 보드 드래그 히트테스트 깨짐. → **방어**: §3 JSX 구조 diff 게이트 + MatrixCanvas critic.

## 5. ralph 사용법

- 한 번에 한 슬라이스. **PR 0(래퍼) 강제 선행** → PR 0.5 → Wave 1→2→3→4→5 순.
- 각 슬라이스: 구현 → 검증(1.3) → (모달/메뉴면 Playwright 스모크) → (결정 레일 인접이면 reviewer) → dev 머지/push → decisions 한 줄 → 다음.
- 슬라이스 간 사용자 승인 불요(자율 루프). 단 (a) 모달/메뉴 슬라이스는 Playwright 스모크가, (b) 결정 레일 인접 슬라이스는 reviewer ACCEPT가 머지 게이트다.
