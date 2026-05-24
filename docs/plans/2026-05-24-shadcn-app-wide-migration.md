# shadcn 앱 전면 적용 — 실행 플랜 (ralph-ready, 2026-05-24)

> **이 문서만 읽고도** 다음 세션/ralph가 컨텍스트 없이 진행할 수 있게 작성. 정본 규칙은
> `AGENTS.md`(working agreement) + `PLAN.md §1`(INVARIANTS) + `DESIGN.md`(시각 정본).
> 명령은 `docs/reference/commands.md`. 이 문서는 *남은 작업 + 슬라이스 + 실행 프로토콜*만 담는다.

## 0. 배경 (현황 실측, 2026-05-24)

- **shadcn 적용 = 사실상 `settings/`만.** `@/components/ui/button` import가 `settings/*` + `SettingsView` + `poc`에만 존재.
- **앱 본체(보드·PR Radar·Jobs·Today·Timeline·Weekly·Worktree·Retro·Hermes·Skills 등)는 raw `<button>/<input>/<select>/<textarea>` + 커스텀 `styles.css`(5724줄)**로 구성.
- **현재 `src/components/ui/`**: `badge·button·card·command·input·label·select·switch` (+`cn`). **없음**: `dialog·dropdown-menu·tooltip·tabs·checkbox·textarea`(+필요 시 `popover·separator·scroll-area`).
- `CommandPalette`는 이미 `cmdk`(`command.tsx`) 기반 → 그대로 둔다.

## 0.5 결정 (사용자 승인 완료)

- **범위 = 프리미티브 이전 + 공간형 토큰 정렬 패스.** 공간형 고유 UI(아이젠하워 2×2 보드·드래그 카드·Today 레일·Worktree diff 뷰어)의 **레이아웃 구조/인터랙션은 변경 금지**, 여백·타이포·색만 DESIGN.md 토큰으로 정렬.
- **슬라이싱 = Foundation → 뷰별(한 PR = 한 뷰).**
- **ToastHost = 커스텀 유지** (react-query `onError`→retry 배선 보존, sonner 이전 안 함).
- **비-목표**: 공간형 레이아웃 구조 재설계, 보드/diff 인터랙션 변경, 결정 레일/IPC/쿼리 로직 변경(행위 100% 보존), 신규 기능.

---

## 1. 실행 프로토콜 (모든 슬라이스 공통 — 반드시 지킬 것)

### 1.1 브랜치/머지 (dev 오염 금지)
- **슬라이스 1개 = 브랜치 1개.** `git checkout -b refactor/shadcn-<slug>` (예: `refactor/shadcn-jobs-view`).
- 순서: 구현 → **검증(1.3)** → `dev` `--ff-only` 머지 → `git push origin dev` → 브랜치 삭제.
- `dev`는 **green만 수령.** `main` 직접 push 금지(husky pre-push 차단).
- **병렬 worktree 에이전트 금지** — 오염 전례. 위임은 **단일·순차 executor**, 오케스트레이터가 독립 재검증.

### 1.2 환경 함정 (실측)
- cargo가 기본 PATH에 없음 → cargo/커밋 전 `export PATH="$HOME/.cargo/bin:$PATH"` (husky pre-commit = `cargo fmt --check` + `pnpm typecheck`).
- rtk 래핑 cargo/grep 출력 부정확 → `rtk proxy ...`로 실행, 파일은 Read 도구로 교차검증. 파이프는 파일 리다이렉트 후 Read.
- 위임 후 늦은 쓰기 주의 → 커밋 직전 `git status --short` 확인.

### 1.3 검증 (체크박스 = 실행 증거, prose 우회 금지)
- **`git diff --exit-code src/bindings.ts` = 빈값** (전부 FE-only — IPC 표면 무변경 증명). 비면 잘못 건드린 것.
- `pnpm typecheck`(0) · `pnpm lint`(신규 **에러** 0; react-hooks 경고는 기존 정책대로 비차단) · `pnpm build` green.
- `pnpm tauri dev` **뷰 육안** — 헤드리스 시각 QA 부재 → **사용자 관찰 항목**으로 명시(체크박스에 "사용자 관찰"로 표기).
- 행위 보존: 핸들러/쿼리/IPC 무변경, className·마크업·프리미티브 컴포넌트만 교체.
- **결정 레일 인접(보드 분류·accept/promote·Acceptance 게이트 버튼) 변경은 self-approve 금지** → `code-reviewer` 또는 `critic` 별도 패스로 INVARIANT #1/#2 보존 확인.
- 각 슬라이스 머지 시 `docs/decisions.md`에 한 줄 + 의도적 시각 변화 기록.

### 1.4 토큰 정렬 규칙
- 색·타이포·라운드·스페이싱은 Tailwind v4 `@theme` 토큰만. **하드코딩 hex 금지**(PR C 선례). 다크는 shadcn 토큰이 `.dark` 자동 적응.
- 라이트 시각은 가능한 한 보존. 불가피한 변화만 의도적으로, decisions에 기록.
- 뷰 슬라이스에서 **이제 dead가 된 그 뷰의 `styles.css` 규칙 제거**(PR D 선례 — 토큰경계 매칭으로 over-deletion 0 증명). styles.css 축소가 부수 목표.

---

## 2. 슬라이스 목록 (순서 = ROI·위험)

> 파일 옆 숫자 = 현재 raw 프리미티브 카운트(2026-05-24 실측). b=button, i=input, s=select, t=textarea, m=모달/오버레이.

### PR 0 — Foundation (프리미티브 추가) [선행 — 다른 슬라이스의 의존]
- **추가**: `src/components/ui/`에 `dialog`·`dropdown-menu`·`tooltip`·`tabs`·`checkbox`·`textarea` (shadcn 표준 radix 기반, 기존 `cn`/토큰 사용). `popover`·`separator`·`scroll-area`는 소비처 만날 때 lazy 추가(YAGNI).
- **건드리지 않음**: ToastHost(커스텀 유지), CommandPalette(cmdk 유지).
- **Done**: 새 프리미티브 6종 추가, 단독 import 시 typecheck/build green, `bindings.ts` drift 0(FE-only), 기존 화면 무변경(소비처 없음).

### PR 0.5 — settings 잔여 raw 정리 [tiny]
- `SettingsView`(b3)·`settings/NavigationSettings`(b2)·`settings/TokenRow`(b1)·`settings/kit.tsx`(b1)·`settings/GoogleCalendarBlock`(i1)의 잔여 raw 프리미티브 → shadcn.
- **Done**: settings 트리 raw `<button>`/`<input>` 0(grep), 검증(1.3).

### Wave 1 — 워밍업 (저위험·패턴 검증)
1. **PrRadarView** (b4) — 행 액션 버튼 → `Button`(variant/size). dead `.pr-*` 정리.
2. **AgentStatusBar** (b1, i1) — 인라인 이름 편집 input → `Input`, 버튼 → `Button`.
3. **SprintTimer** (b8, i2, m1) — 일정 편집 모달 → `Dialog`, 버튼/인풋 → 프리미티브.
4. **ErrorBoundary** (b2) + **Spinner** (표시) — 버튼 → `Button`, Spinner 토큰 정렬.
- **Done(각)**: 해당 뷰 raw 프리미티브 0, dead CSS 제거, 검증(1.3) + 육안(사용자 관찰).

### Wave 2 — 모달/메뉴 (Foundation 의존)
5. **CardMenu** (b10) → `dropdown-menu`. **결정 레일 인접**(백로그/안건/캘린더 승격·Today·snooze/done/archive) → **code-reviewer 패스 필수**(INVARIANT #1/#2, accept 전 외부 무변경).
6. **EnrichModal** (b2, s2, t1, m) → `Dialog`+`Select`+`Textarea`. **suggested-only 유지**(자동 분류 0 — INVARIANT #1).
7. **CalendarEventModal** (b2, i4, s1, t1, m) → `Dialog`+`Input`+`Select`+`Textarea`.
8. **ProjectPickerModal** (b2, s1, m) → `Dialog`+`Select`.
9. **EnrichReviewPanel** (b3, s2) → 인보드 리뷰 프리미티브 교체(suggested-only 유지).

### Wave 3 — 대형 리스트
10. **JobsView** (b18, i1, s4, t5) — 잡 제어/필터/프롬프트. **kill/cost cap/Acceptance 게이트 버튼은 행위 보존 + code-reviewer**(INVARIANT #2/#5).
11. **TodayView** (b13) — Today 레일/완료/되돌리기 버튼(로컬 액션 — 행위 보존).
12. **WorktreeView** (b13, i2, s3) — 비교모드 셀렉트/패널 버튼(읽기 전용 #6, diff 레이아웃 토큰만).

### Wave 4 — 보조 뷰
13. **RetroView** (b7) · 14. **TimelineView** (b6) · 15. **WeeklyView** (b1)
16. **HermesView** (b4, i1) · 17. **SkillsView** (b9, i3, s1, t3) · 18. **RoutineTrackingView** (b2)

### Wave 5 — 보드 코어 (THESIS — 가장 신중, 토큰 정렬 위주)
19. **CapturePanel** (b3, i1) — 캡처 입력/세그먼트 토글.
20. **MatrixCanvas** (b2, t1) — **드래그 분류·사분면 로직 절대 무변경**(INVARIANT #1), 토큰 정렬 + 프리미티브 스왑만. **critic 패스**.
21. **TodayRail** (b1) · 22. **RoutinesPanel** (b8, i3) · 23. **CalendarDrawer** (b8, m)
24. **CaptureBoard** (b1, t1) — 보드 셸 토큰 정렬.

---

## 3. 완료 정의 (전체)
- 전 뷰 raw `<button>/<input>/<select>/<textarea>` → shadcn 프리미티브(공간형 캔버스 제외 영역 0). `rtk proxy grep`으로 잔여 카운트 추적.
- 공간형 UI 토큰 정렬 완료(하드코딩 hex 0 in 대상 영역).
- `styles.css` 축소(dead per-view CSS 제거).
- 매 슬라이스 `bindings.ts` drift 0 · typecheck/lint/build green · 육안(사용자 관찰) · decisions 한 줄.
- 결정 레일 인접 슬라이스(5·6·9·10·20)는 code-reviewer/critic ACCEPT.

## 4. INVARIANTS 적합성
- **#1 결정 레일**: 시각/프리미티브만 교체, 분류·승격·suggested 로직 무변경. Wave 2·3·5의 인접 슬라이스는 reviewer 패스로 잠금.
- **#2 Acceptance 게이트**: accept/promote 버튼 리스킨해도 "accept 전 외부 무변경" 보존.
- **#5 bounds**: Jobs kill/cost cap 버튼 행위 보존.
- **#6 read-only**: Worktree diff 표시 전용 유지.
- 나머지(#3/#4/#7)는 FE 리스킨이라 무관.
- **AGENTS.md**: 한 PR = 한 뷰(한 관심사), 순수 리스킨이라 feature/refactor 비혼합.

## 5. ralph 사용법
- 한 번에 한 슬라이스. PR 0(Foundation) 선행 → PR 0.5 → Wave 1→2→3→4→5 순.
- 각 슬라이스: 구현 → 검증(1.3) → (결정 레일 인접이면 reviewer) → dev 머지/push → decisions 한 줄 → 다음.
- 슬라이스 간 사용자 승인 불요(자율 루프), 단 결정 레일 인접은 reviewer ACCEPT가 게이트.
