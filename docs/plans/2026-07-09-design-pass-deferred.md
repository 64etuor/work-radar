# 디자인 정합 패스 — Deferred 후속 런북 (2026-07-09)

본편은 `docs/decisions.md` 2026-07-09 entry 참조. 이 문서는 **다음 세션이 그대로 집어들 수 있는**
후속 작업 지침이다. 각 항목은 독립적 — 순서 무관, 한 항목 = 한 커밋/PR 단위 권장.
공통 게이트: `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm check:design-tokens && pnpm exec vite build`.

## 0. 라이브 스모크 (코드 변경 전에 먼저 — 이번 패스의 시각 변화 검수)

- [ ] `pnpm tauri dev` 부팅 → Dialog/Sheet/Select/Popover 열고 닫기: enter/exit 느낌, 닫힘 직후 즉시 클릭 가능(click-shield 없음) 확인.
- [ ] **cmux Esc 스모크**(shadcn-migration.md §cmux 브라우저 스모크 절차): 모달 exit 애니메이션이 추가돼
      `data-wr-overlay-open` 마커가 exit 동안 ~120ms 더 살아있다(의도 — Esc 창보호가 오히려 안전).
      단언: Esc로 모달만 닫히고 창 유지 + 트리거 포커스 복원.
- [ ] 창 하단에서 Select 열기(side=top 플립) — 트리거 쪽에서 자라나는지(origin 배선 확인).
- [ ] Hermes 패널/슬래시 메뉴 그림자 — `shadow-lg`가 `--wr-shadow-lg`(더 크고 부드러움)로 별칭돼
      무거워졌는데 의도적 수용이었다. 눈으로 보고 과하면 그 두 곳만 `shadow-[var(--wr-shadow-md)]`로 강등.
- [ ] 다크 모드 한 바퀴(헤더/EmptyState/스켈레톤/배지 sm).
- [ ] 루틴/가계부 체크박스 체크 시 스프링 팝 1회, 뷰 전환 시 팝 폭풍 없음.

## 1. CommandPalette · ToastHost exit 애니메이션 (언마운트 지연 기계 필요)

현황: 두 표면 모두 enter만 있고 close는 하드 컷(`{paletteOpen && …}` 즉시 언마운트 / 토스트 store 즉시 제거).
radix가 아니라 Presence가 없어서 exit을 붙이려면 지연 언마운트가 필요.

- **Palette**: `App.tsx`의 조건부 렌더를 소형 presence 훅(예: `usePresence(open, ms)` — closed 후
  `var(--wr-motion-fast)`=120ms 유지)으로 감싸고 `data-state="open|closed"` 부여,
  `motion.css`에 `.cmdk-overlay[data-state="closed"]`/`.cmdk-panel[data-state="closed"]` exit 추가.
  **주의**: ① `CommandPalette.tsx`는 "변경 시 신중"(frontend-shell.md) — 열림/포커스/Esc 계약 무변경,
  래퍼에서만 해결. ② closed 동안 `pointer-events: none` 필수(click-shield 금지).
  ③ 팔레트 Esc는 App.tsx가 직접 처리(overlay 마커 아님)라 툴팁 같은 마커-수명 문제는 없음.
  ④ reduced-motion: closed 즉시 언마운트(1ms) 또는 opacity 0.
- **Toast**: `src/lib/toast.ts` store에 `leaving: true` 마킹 → 120ms 후 실제 제거.
  `ToastHost`에서 `.toast-item[data-leaving]`에 fade-out. auto-dismiss(2500ms) 경로도 동일 경유.

## 2. skills/\*.tsx 기본 사이즈 pill ~22곳 (결정 필요했던 것)

`AuditPanel/CreatePanel/InstallPanel/VendorPanel/DivergencePanel/ManagedViewer/ExternalViewer`

- `BackupPanel/UpdatePanel/InAppEditor`의 `.skl-actions`/`.skl-edit-top` 행에 size prop 없는
  `<Button className="…rounded-full…">`가 남아 있다(h-9/text-sm/px-4).

* **제로-델타 경로(권장)**: `size="pill"` + `className="px-4"` — pill의 px-5를 px-4로 되돌려
  픽셀 동일, rounded-full 수기 제거. non-wrapping 행 overflow 리스크 0.
* 또는 px-5 수용(+1px/side×버튼 수) 시 `.skl-actions` 행이 좁은 폭에서 안 넘치는지 라이브 확인.
* `TodayHeader.tsx:96`의 `h-[26px]` pill은 형제 아이콘 버튼(`size-[26px]`)과 행 높이 결속 —
  바꾸려면 행 전체(아이콘 3개 포함)를 h-8로 함께 올려야 한다. 단독 변환 금지.

## 3. worktree `.wt-empty` 패밀리 (12+ 사이트, 이번 패스 의도적 스킵)

`.wt-empty`가 `.wt-err`와 규칙 공유 + 상당수가 실제로는 _loading_("diff 로드 중…")이거나
프롬프트("파일을 선택하면…")라 EmptyState 일괄 치환이 부적절했다.

- 먼저 사이트를 3분류: 진짜 empty → `<EmptyState>`; loading → 스켈레톤/`<Spinner>`(JobList 선례);
  프롬프트(안내) → 유지 또는 EmptyState(문구 그대로).
- `.wt-empty-action`의 좌측 정렬(align-items: flex-start)은 의도 — 그 사이트는 className으로 보존.
- `WorktreeEmptyState.tsx`(별도 컴포넌트)는 무접촉.

## 4. 잔여 R3 baseline 37건 — 새 typo 롤 없이는 해소 불가

남은 대부분이 세 부류(이번 스윕의 weight-보존 규칙이 걸러낸 것):
① 13px/500 (`SettingsKit` Field 라벨, `Segmented`, News 설정 등) ② mono 소문자(uppercase 강제라
`typo-mono-*` 부적용: `ui/command` kbd, AgentsPane 등) ③ `leading-none` 동반(CommandPalette 배지 등).

- 진행하려면: `typo-label-md`(13px/500/1.4) 신설 — `tokens.css`(--text 재사용) + `typography.css`
  - `tw.ts` TYPO_SUFFIXES + DESIGN.md §App Surface Type 표 + `docs/areas/typography.md`. 이후 ①만 스윕.
- ②③은 롤을 만들지 말 것(소문자 mono·leading-none은 컴포넌트 사정) — baseline에 남기는 게 맞다.
- 스윕 후 `pnpm check:design-tokens --update-baseline`으로 감소 확인(늘면 잘못한 것).

## 5. 뷰 전환 크로스페이드 재도입 (기각됨 — 조건부로만)

`motion.css`에 기각 사유 주석 있음: 뷰 서브트리 opacity 애니메이션 = WKWebView 레이어
승격/강등 = stale-paint 재무장(`scheduleCompositorResync` 관련 메모리/TodayView.css 주석 참조).

- 재시도한다면 **콘텐츠가 아닌 얇은 veil**(view-stage 위 absolute 흰 오버레이가 fade-out;
  콘텐츠 자체는 무애니메이션)로 — veil만 합성 레이어를 먹고 콘텐츠 레이어는 불변.
- 조건: TodayView(타임라인 블록 다수)에서 전환 직후 드래그/스크롤 stale-paint 라이브 스모크 통과.

## 6. 소형 후속(기회 있을 때)

- `wr-fade-in` ≡ `wr-backdrop-in` 중복 키프레임(패스 이전부터) — 하나로 병합 가능.
- `bookkeeping/cards/_shared.tsx` EmptyState 래퍼: 소비처 2곳이라 직접 `<UiEmptyState className="bk-empty">`
  인라인 후 래퍼 삭제 가능(선택).
- `--wr-ease-loop`을 기존 루프들(ControlRoom `cr-flow-*`, `wt-pulse`, `caldrawer` 외 잔여)로 확대 —
  duration은 루프 주기라 개별 유지, easing만 토큰.

## 함정 (메모리 `work-radar-design-system-pass`와 동일 — 코드에 주석으로도 박혀 있음)

- 툴팁은 enter-only(`wr-tooltip-content`) — exit 달면 마커 잔존으로 전역 키 120ms 먹통.
- 오버레이 closed 상태 = 반드시 `pointer-events: none`.
- 체크박스 `wr-check-pop`은 ref 마운트 게이트 유지(state로 바꾸면 팝 폭풍 재발).
- CSS 주석에 `*/` 포함 문구 금지(`duration-*/ease-*` 사고) — prettier/vite build만 잡는다.
- `tokens.css` 모션 값 변경 시 `src/lib/motion.ts` 동기화(패리티 테스트가 강제).
