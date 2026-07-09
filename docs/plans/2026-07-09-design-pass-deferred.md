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

## 1. CommandPalette · ToastHost exit 애니메이션 — ✅ DONE (2026-07-09)

`src/lib/usePresence.ts` 신설, 팔레트는 `.cmdk-presence` 래퍼(`display: contents`, closed 동안 `inert`),
토스트는 `leavingSeq` 기반 지연 제거. `CommandPalette.tsx`는 무접촉. exit 키프레임은 신설 없이
기존 `wr-fade-out`/`wr-dialog-pop-out` 재사용. 계약은 `src/lib/overlayExit.test.ts`가 고정.

구현하며 드러난 것 — **다음 presence 소비처가 반드시 알아야 한다**:

- **전이를 effect에서 켜면 닫힘 첫 커밋에 서브트리가 언마운트됐다 되살아난다.** `mounted = open || closing`
  인데 effect가 아직 안 돌아 `closing=false`이기 때문. 노드가 갈리므로 exit이 새 노드에서 재시작되고
  한 프레임 깜빡인다. `usePresence`는 전이를 **렌더 중에** 반영해(React "prop 변화에 state 맞추기")
  이를 피한다. `act()`가 effect를 동기로 흘리므로 일반 렌더 테스트로는 안 잡히고,
  자식 마운트 카운터가 있어야 보인다(`usePresence.dom.test.tsx`).
  `HermesPanel.tsx`도 같은 구멍이 있었고 후속 커밋에서 `usePresence`로 이관했다(아래 §7).
- **exit 유예 동안 노드가 살아 있으므로 재오픈해도 자식이 언마운트되지 않는다** — `autoFocus` 같은
  마운트 전용 효과가 안 돌고 내부 state(팔레트 검색어)가 남는다. `usePresence.openKey`를 자식 `key`로.
- **`exitMs`는 effect deps에 넣지 말 것.** 닫힌 동안 값이 바뀌면 cleanup이 타이머만 지우고 재예약을
  못 해 영구히 mounted로 남는다(ref로 고정).
- **exit 타이머는 애니메이션 길이보다 길어야 한다(+40ms).** 타이머는 dismiss 호출 시각에 출발하지만
  애니메이션은 커밋·페인트 후 시작 → 같은 값이면 마지막 프레임이 잘린다.
- 토스트 id는 백엔드 traceId라 **재사용된다**. 지연 제거를 붙이면 ① 중복 가드가 fade 중인 토스트를
  살아 있는 중복으로 오인해 새 에러를 삼키고 ② 묵은 타이머가 자리를 넘겨받은 새 토스트를 지운다.
  → 가드는 `leavingSeq === undefined`만 중복으로 보고, 타이머는 자기 seq만 제거.
- reduced-motion: `animation: none`만으론 closed 노드가 유예 동안 **그대로 보인다** → `opacity: 0` 필수.

## 2. skills/\*.tsx 기본 사이즈 pill — ✅ DONE (2026-07-09, 제로-델타 경로)

실제 사이트는 **23곳**(10개 패널). 전부 `size="pill" className="… px-4"`로 전환, 수기
`rounded-full` 0건. 픽셀 동일함을 `cn` 실제 출력으로 확인했다(3 variant × gap 유무 6조합에서
전/후 클래스가 `py-2` 하나만 다르고, 그건 `h-9` 고정 높이 + `items-center`에서 무해).

- **남은 결정**: 캐논 pill 패딩은 `px-5`인데 여기는 `px-4`로 되돌려 두었다. `px-5` 채택은
  `.skl-actions` 행이 좁은 폭에서 안 넘치는지 **라이브 확인**이 필요해 미뤘다. 채택 시
  `className="px-4"`만 지우면 된다.
- `TodayHeader.tsx:96`의 `h-[26px]` pill은 형제 아이콘 버튼(`size-[26px]`)과 행 높이 결속 —
  바꾸려면 행 전체(아이콘 3개 포함)를 h-8로 함께 올려야 한다. 단독 변환 금지. (무접촉)

## 3. worktree `.wt-empty` 패밀리 — ✅ DONE (2026-07-09)

실제 사이트는 **11곳**. 3분류 결과:

| 분류          | 개수 | 처리                                                                         |
| ------------- | ---: | ---------------------------------------------------------------------------- |
| loading       |    4 | `.wt-loading`(신설, `.jobs-loading` 선례 = flex+중앙) + `<Spinner />`        |
| 진짜 empty    |    4 | `<EmptyState className="wt-empty">` (geometry만 클래스, 타이포는 프리미티브) |
| 안내 프롬프트 |    2 | 유지 — "비어 있음"이 아니라 행동 요구(주석으로 명시)                         |
| empty + 액션  |    1 | 유지 — 아래 사유                                                             |

- loading 4곳 중 3곳은 이미 `<Spinner/>`를 `.wt-empty`에 담고 있어 클래스가 의미를 배신했다.
  나머지 1곳(`WorktreeDiffPanel` "diff 로드 중…")은 같은 파일 형제(:230)와 불일치 → Spinner로 통일.
- **`WorktreeReviewPanel`의 `LensEmptyState`는 EmptyState로 옮기지 않았다.** 메시지 + 액션 버튼
  구조인데 `EmptyState`는 `title`/`children`만 받아, 버튼을 `children`에 넣으면
  `typo-body-md text-muted-foreground` 래퍼에 갇히고 `.wt-empty-action`의 `gap: 10px` 컬럼
  레이아웃이 깨진다. 프리미티브가 액션 슬롯을 갖게 되면 그때 이관.
- `WorktreeEmptyState.tsx`(별도 컴포넌트)는 무접촉.
- **시각 변화 있음**(진짜 empty 4곳: 좌측→중앙 정렬, line-height normal→1.4). 라이브 확인 필요.

## 4. `typo-label-md` 신설 + ① 스윕 — ✅ DONE (2026-07-09, baseline 37 → 34)

`typo-label-md`(13/500/1.4/0) 신설. **새 토큰 0개** — `typo-body-strong`가 이미
`--text-body-md`를 600 weight로 재사용하는 선례를 따라 같은 토큰에 500만 얹었다.

- 스윕한 ① 그룹은 **5곳/3파일**: `SettingsKit`(Field 라벨 + Segmented md), `NewsMarqueeSpeedField`,
  `NewsSourceSettings` ×2. baseline 3건 제거(삭제만 — 단조 감소).
- **드리프트 가드 신설**: `tw.ts`의 `TYPO_SUFFIXES`와 `typography.css`의 `@utility typo-*` 목록
  패리티를 `tw.test.ts`가 강제한다. 없으면 새 role 추가 시 `tw.ts`를 잊어도 조용히 실패한다
  (`cn()`이 병합 못 해 빌트인이 cascade로 이김). 변이 테스트로 non-vacuous 확인.
- **남긴 부류(롤 만들지 말 것)**: mono 소문자(`ui/command` kbd, `SkillRootsSettings`, `RepoRow`),
  `font-semibold`(ErrorBoundary=600), 컨트롤 프리미티브의 arbitrary 텍스트 크기
  (`SprintTimer`/`SettingsView`/`CalendarDrawer`의 Button — typo role이 아니라 **Button size
  variant**로 정규화하는 게 옳다, `typography.md` 참조).
- 남은 baseline 34건은 위 부류 + `leading-none` 동반 사이트들. 여기서 더 줄이려면 Button size
  variant 트랙이 필요하다.

## 5. 뷰 전환 크로스페이드 재도입 (기각됨 — 조건부로만)

`motion.css`에 기각 사유 주석 있음: 뷰 서브트리 opacity 애니메이션 = WKWebView 레이어
승격/강등 = stale-paint 재무장(`scheduleCompositorResync` 관련 메모리/TodayView.css 주석 참조).

- 재시도한다면 **콘텐츠가 아닌 얇은 veil**(view-stage 위 absolute 흰 오버레이가 fade-out;
  콘텐츠 자체는 무애니메이션)로 — veil만 합성 레이어를 먹고 콘텐츠 레이어는 불변.
- 조건: TodayView(타임라인 블록 다수)에서 전환 직후 드래그/스크롤 stale-paint 라이브 스모크 통과.

## 6. 소형 후속 — ✅ 2/3 DONE, 1건 기각 (2026-07-09)

- ✅ **키프레임 병합**: `wr-backdrop-in` 삭제, 소비처 2곳(`.wr-dialog-overlay`, `.cmdk-overlay`)을
  `wr-fade-in`으로. 바이트 동일 확인 후 병합했고, `wr-fade-out`과 이름이 짝을 이루는 쪽을 남겼다.
- ❌ **기각 — `bookkeeping/cards/_shared.tsx` EmptyState 래퍼**: 플랜은 "소비처 2곳"이라 했으나
  실제 **8곳**(Operations/CategorySummary/RecurringMonth/BudgetPlanner/TrashTransactions/
  ReviewQueue/Reports/ApprovedTransactions). 래퍼를 지우면 8곳에 `<UiEmptyState className="bk-empty">`가
  복붙된다 — 래퍼가 정당하다. 유지.
- ✅ **`--wr-ease-loop` 확대**: 무한 루프 19개를 전수 분류해 리터럴 `ease-in-out` **4곳**만 토큰화
  (`wt-pulse`, `cr-flow-attention`, `cr-flow-inflight`, `cr-ghost-breathe`). 토큰 값이 정확히
  `ease-in-out`이라 시각 변화 0. duration은 루프 주기라 개별 유지.
  **대상 아님**: `linear` 루프(`wr-spin`/`cr-spin`/`cr-flow-dash`/`hbl-*`/news 마퀴 — 회전·마퀴는
  등속이어야 한다), `BrainDumpToggle`의 `wr-pulse-ring`(커스텀 베지어 — 토큰화하면 느낌이 바뀐다).

## 7. 런북 밖에서 발견해 함께 고친 것 (2026-07-09)

이 런북을 진행하다 드러난 **기존 버그** 3건. 셋 다 이 패스가 만든 게 아니다.

- **Mission 기반 탭 / Guardrail** — `LifeOsAdvisorPanel`이 생성 UI가 사라진 `가드레일 N` 배지를
  계속 렌더해 신규 사용자에겐 영구 0 지표가 됐다. 배지 제거. **백엔드/DB teardown은 미완**
  (마이그 0067 테이블 · 0068 컬럼 · 0069 CHECK enum → SQLite 테이블 rebuild 3건). 별도 PR.
- **`CleanupPanel` 클래스 이어붙기** — `` `wt-cleanup-row${can ? "" : "wt-cleanup-locked"}` `` 가
  `can=false`일 때 단일 토큰 `wt-cleanup-rowwt-cleanup-locked`를 만들어 **두 클래스 모두** 죽였다.
  ⚠️ **분기 문자열 앞 공백은 수정이 못 된다** — `prettier-plugin-tailwindcss`가 지운다(실측).
  `cn()`을 쓰거나 공백을 리터럴 쪽(`${` 앞)에 둔다. `check-classname-regression` 가드가 이 케이스
  (true 분기가 빈 문자열)를 놓치고 있었고, 헤더 주석이 자멸적 수정법을 "올바른 모양"이라 적어뒀다.
  → 가드를 양쪽 분기 검사 + lookbehind + 주석 스킵으로 고치고 `scripts/*.test.mjs` 신설.
- **HermesPanel** — ① 위 §1의 언마운트 깜빡임 ② `data-state="closed"`에 `pointer-events: none`
  누락 → 닫는 220ms 동안 `fixed z-50` 720×780 패널이 클릭을 삼켰다(다른 오버레이 4곳엔 전부 있음).
  `usePresence` 이관 + `pointer-events: none` + `inert`.

**남은 것**: `HermesPanel.tsx`의 `animate-[hermesDot_1.2s_ease-in-out_infinite]` — §6의 루프 easing
전수 조사는 CSS 파일만 훑었다(TSX arbitrary 값은 미포함). 토큰화 가치는 낮다.

## 함정 (메모리 `work-radar-design-system-pass`와 동일 — 코드에 주석으로도 박혀 있음)

- 툴팁은 enter-only(`wr-tooltip-content`) — exit 달면 마커 잔존으로 전역 키 120ms 먹통.
- 오버레이 closed 상태 = 반드시 `pointer-events: none`.
- 체크박스 `wr-check-pop`은 ref 마운트 게이트 유지(state로 바꾸면 팝 폭풍 재발).
- CSS 주석에 `*/` 포함 문구 금지(`duration-*/ease-*` 사고) — prettier/vite build만 잡는다.
- `tokens.css` 모션 값 변경 시 `src/lib/motion.ts` 동기화(패리티 테스트가 강제).
