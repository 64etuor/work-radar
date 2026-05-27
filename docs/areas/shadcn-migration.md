# shadcn Migration & Primitive Discipline

shadcn/ui + Tailwind v4 + radix가 본체. **앱 전면 마이그레이션은 완료**(Wave 1–5,
dev `fe08b8a`). 이 문서는 신규 컴포넌트/뷰에 적용되는 **분별 규율**이다.

## Grounding rule (사전)

UI 변경 제안 전, 이미 깔린 스택 위에 있는지 먼저 확인하고 근거를 제시한다:

- 아이콘 = `lucide-react`(shadcn 본체가 쓰는 표준). 별도 아이콘 컴포넌트 도입 금지.
- 프리미티브 = `src/components/ui/**`(이미 dialog, dropdown-menu, select, tabs, tooltip,
  toggle-group, checkbox, textarea, input, button, badge, card, command, label, slider,
  switch, cn 유틸 보유. lazy 미도입: popover/separator/scroll-area).
- 토큰 = Tailwind v4 `@theme` (`src/styles.css`, `--color-wr-*`).

솔루션을 던지기 전 위 3개 중 어디에 이미 있는지 1줄로 말한다.

## 마이그레이션 결정 트리 (grep ≠ target)

raw `<button>/<input>`을 발견해도 즉시 변환하지 않는다:

1. **이미 토큰만 쓰는 요소면 무변경.** (Spinner 패턴.)
2. **bespoke 위젯이면 keep + `docs/decisions.md`에 근거 한 줄.** bespoke 표지:
   - 전폭/상태바 트리거(예: AgentStatusBar `asb-box`),
   - 동적 `div|button` 태그 스왑(진행 박스),
   - `overflow:hidden` 부모 안 인라인 에디터(`MatrixCanvas` `postit-edit` — Textarea 링이 클립),
   - 키스트로크 캡처 필드(capture-Esc, NavigationSettings 키캡처),
   - 복합 컨트롤(요일토글·세그먼트 — `toggle-group` 도입 후에도 5+ 오버라이드면 keep),
   - 디스클로저/체크박스가 label 행 전체 클릭(GoogleAccountBlock, TokenRow, RoutinesPanel).
3. **클린 매핑(≤~3 오버라이드 + 회귀 0)일 때만 변환.** 강제 변환 시 레이아웃/동작/포커스가
   회귀한다(Wave 1.2 AgentStatusBar 무변환 결정).

## radix Dialog Esc 계약 (hard gate)

`App.tsx`의 window-bubble Esc 핸들러는 `getCurrentWindow().hide()`를 호출한다. 따라서
모달 추가 시 **반드시** overlay-stack 계약을 따라야 Esc가 모달만 닫히고 창이 살아남는다.

### 패턴

- `src/components/ui/overlay-stack.ts`의 `registerOverlay()`/`isOverlayOpen()`을 사용.
  PR 0 래퍼(`DialogContent`·`DropdownMenuContent`·`SelectContent`)는 열린 동안 자동 등록.
- App.tsx Esc 핸들러가 `isOverlayOpen()`이면 창 hide를 양보한다.
- **`DialogTrigger asChild`로 트리거를 감싸야 포커스 복원이 동작.** controlled `open`만
  쓰면 Esc 후 포커스가 `body`로 샌다(정적 게이트가 못 잡음).
- 프로그램적 모달(부모 `{state && <Modal>}`)은 DialogTrigger 없음 OK — body 복원 허용
  (overlay-stack unregister가 post-commit이라 창보호 OK).
- draft 상태 초기화는 필드를 `DialogContent` **자식 컴포넌트**로 분리해 열림마다 마운트
  (상태 초기화 + radix가 mount/unmount·포커스 소유).

### cmux 브라우저 스모크 (hard gate, 모달/메뉴 슬라이스만)

정적 게이트는 Esc 계약 위반을 검출 못 한다. 새 Dialog/DropdownMenu 슬라이스는
**cmux 브라우저 인터랙션 스모크가 hard gate**:

1. `cmux browser open http://localhost:1420`(vite dev) — Tauri 스텁 주입은
   build에 따라 다름. 현 build엔 `addinitscript` 없음 → post-boot `eval`로
   `window.__TAURI_INTERNALS__`(metadata.currentWindow + invoke hide-spy) 주입.
2. 모달 트리거 클릭 → `cmux browser press Escape`.
3. 단언: `dialogStillOpen === false` AND `hideCalls === []`(window.hide 미호출)
   AND `document.activeElement === <트리거>` (포커스 복원).

선례: SprintTimer Wave 1.3, CardMenu Wave 2.5(Option E — overlay-stack만 채택),
CalendarDrawer Wave 5.23(bespoke 셸 keep + 트리거 포커스 복원 추가).

비-모달 Select 슬라이스는 Esc 스모크 불요(EnrichReviewPanel 2.9 선례). Select는
overlay-stack `registerOverlay()`로 계약 배선(PR 0 단위테스트).

## Button 변형 매핑

- **pill** = `variant="outline" size="sm" className="rounded-full text-[..]"`
- **nav/토글** = `variant="ghost"|"outline"` + active className(`bg-secondary` 또는 accent border)
- **filled CTA** = `default` (= `--primary` ink `#17171c`, NOT coral) — Wave 1-2에서 확립된
  의도적 Cohere 정렬. coral→ink는 회귀 아님.
- **다중버튼 토글그룹** = 개별 Button + active variant swap (`variant={active?"default":"outline"}`, `aria-pressed`).
- `cn()`(tailwind-merge)로 base 오버라이드 정상.

## radix Select 빈값

native `<option value="">`는 `__none__`/`AREA_NONE`/`REF_NONE`/`BIND_NONE` 센티넬로,
write 시 `v === NONE ? null : v` 매핑. value가 항상 non-null이면 placeholder 불필요.

## SelectTrigger 기본 width 주의

`SelectTrigger`는 기본 `w-full`. 헤더/인라인 select는 `w-auto`/`w-[Npx]` + `ml-auto`로
오버라이드(안 하면 전폭 스트레치 회귀). 라벨 래핑 select는 `<label>` 유지 OK.

## ToggleGroup (5.19 도입)

`src/components/ui/toggle-group.tsx` — thin 래퍼, overlay 아님이라 Esc 계약 불필요.
활성색은 소비처가 `data-[state=on]:*`로. 디셀렉트 가드 `(v) => v && set(v)`로 single 모드 보호.

## CSS namespace dead-cleanup

뷰 간 공유 CSS 네임스페이스(`.rt-*` 등)는 **마지막 소비처 슬라이스에서만** dead 제거.
양쪽 변환 완료 전 제거하면 라이브 의존이 깨진다.

## 보드 코어 보호

- **MatrixCanvas는 무변경 keep** — 3 프리미티브 전부 bespoke(inbox-enrich-all, menu-btn,
  postit-edit). hex 0, 결정레일 핸들러 무변경.
- **CalendarDrawer 셸은 keep** — 자체 capture-Esc + stopPropagation이 App bubble hide를
  차단하는 계약이 정확. radix Dialog로 강제 변환 시 반응형 사이드시트 구조가 깨짐.

## 남은 작업

- PR 0 lazy 미도입 프리미티브: popover, separator, scroll-area — 소비처 없어 YAGNI 유지.
  소비처 등장 시 도입.
- 신규 뷰는 처음부터 shadcn + 위 분별 적용.

## 정본 / 참조

- `docs/plans/2026-05-24-shadcn-app-wide-migration.md` — 전체 플랜
- `docs/decisions.md` — Wave 0/0.5/1~5 결정 entries
- `src/components/ui/overlay-stack.ts` + `overlay-stack.test.ts` — Esc 계약 단위테스트
