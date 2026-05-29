# overlay-stack 단일 진실원 리팩터 (Design / 핸드오프)

> 상태: design / 다음 세션에서 plan→구현. 별도 PR(한 관심사). 현재 knob 버그픽스(dev `a7b618f`)
> 위에서 출발. 관련: `docs/areas/frontend-shell.md`, `docs/areas/shadcn-migration.md`(overlay 계약 §0.6).

## 0. 다음 세션 핸드오프 (여기부터 읽어)

- knob 미표시 버그는 **이미 수정·푸시됨**(dev `a7b618f`): `isOverlayOpen()`을 카운터+DOM 하이브리드로.
  이 문서는 그 하이브리드의 **잔여 구조 스멜을 없애는 후속 리팩터** 설계다. 기능 버그는 없음 — 코드 헬스 개선.
- 시작점: §3 목표 설계 → §4 작업 분해로 plan 작성(`superpowers:writing-plans` 또는 OMC planner) → 구현.
- 검증 환경 주의: `vitest.config.ts`가 `environment: "node"`라 **DOM 기반 단위 테스트가 현재 불가**.
  이 리팩터의 핵심 결정 = "jsdom/happy-dom 도입할지"(§5). 그게 이 PR의 가장 큰 스코프 판단.

## 1. 근본 문제 (anti-pattern)

`src/components/ui/overlay-stack.ts`의 `registerOverlay()`/`openCount`는 **React/DOM 상태를 모듈
전역 정수 카운터에 수동 미러링**한다. 부수효과를 effect에서 손으로 세는 구조라 본질적으로 drift에 취약:

- React **dev StrictMode**의 effect reconnect(이중 마운트) + radix Presence 마운트 churn으로
  register/unregister가 비대칭 집계 → 실제 열린 오버레이가 없는데도 `openCount > 0` 고착(**over-count**).
  → 뷰 전환 잦은 worktree에서 `isOverlayOpen()`이 영구 true → CmdKnob 억제 + 셸 Esc→hide 어긋남.
- (역방향 **under-count**도 구조상 가능: 등록 누락/이중 해제. 현재는 `released` 가드로 드물지만 0은 아님.)

진단 근거(이번 세션, `localhost:1420` cmux 브라우저): worktree 진입 시 `OPEN=1`인데 DOM에 열린
오버레이 0개. 스택 프레임 = `reconnectPassiveEffects`/`commitHookPassiveMountEffects`(= StrictMode/
offscreen effect 재실행).

## 2. 현재 수정(하이브리드)과 잔여 스멜

`a7b618f`의 `isOverlayOpen()`:

```ts
export function isOverlayOpen(): boolean {
  if (openCount <= 0) return false; // (a) 카운터 게이트
  if (typeof document === "undefined") return true; // (b) test/node 폴백
  return document.querySelector(OPEN_OVERLAY_SELECTOR) !== null; // (c) DOM 진실
}
```

견고하지만 **단일 진실원이 아님**:

1. **이중 진실원**: 카운터 + DOM 동시 의존.
2. **(a) 게이트의 under-count 취약성**: 카운터가 과소 drift하면 실제 열린 오버레이가 있어도 false.
3. **마커 열거 결합**: `OPEN_OVERLAY_SELECTOR`에 오버레이 종류를 하드코딩 → 새 오버레이마다 추가 필요.
4. **죽은 코드 위험**: 브라우저 경로가 DOM을 신뢰할수록 `registerOverlay`/카운터는 (b) 폴백 외엔 무의미.

## 3. 목표 설계 — DOM 단일 진실원

**수동 카운터를 제거하고 DOM을 유일한 진실원으로.** 두 가지 하위 결정:

### 3.1 오버레이 "열림" 마커 통일 (결합도 제거)

종류별 selector 열거 대신 **공통 계약 속성**을 모든 오버레이가 열림 콘텐츠에 단다:

- 제안: 열린 오버레이 루트에 `data-wr-overlay-open`(또는 기존 radix `[data-state="open"]` 일관 채택).
- radix 계열(Dialog/Select/Dropdown/Popover): 래퍼 컴포넌트(`dialog.tsx`/`select.tsx`)에서 Content에
  속성 부여(또는 radix가 이미 다는 `[data-state="open"]` + portal 마커를 신뢰).
- bespoke(CommitGraphDrawer/BrainDumpToggle/CardMenu): 같은 속성 부여.
- `isOverlayOpen()` = `document.querySelector('[data-wr-overlay-open]') !== null` **한 줄**.

> 대안(마커 미통일): `a7b618f`의 `OPEN_OVERLAY_SELECTOR` 열거를 유지하되 카운터만 제거. 결합도는
> 남지만 변경 최소. plan 단계에서 택1(통일 마커=깔끔/광범위 vs 열거 유지=국소).

### 3.2 `registerOverlay` 제거

- `registerOverlay`/`openCount`/`released` 삭제.
- 호출부 5곳에서 `useEffect(() => registerOverlay(), [])` 제거(또는 마커 부여 effect로 대체):
  - `src/components/ui/dialog.tsx` (DialogContent)
  - `src/components/ui/select.tsx` (SelectContent)
  - `src/components/worktree/CommitGraphDrawer.tsx`
  - `src/components/board/BrainDumpToggle.tsx`
  - `src/components/board/CardMenu.tsx`

→ 손으로 세는 부기가 없어 **drift 원천 차단**(over/under 둘 다 해당 없음).

## 4. 작업 분해 (plan 초안)

1. 마커 전략 확정(§3.1 택1) — `decision-rails`/area 문서 영향 없음(표시 보조).
2. `overlay-stack.ts`: `isOverlayOpen` = DOM 단일 쿼리. `registerOverlay`/카운터 제거(또는 deprecate).
3. 호출부 5곳 정리(마커 통일 시 속성 부여, 열거 유지 시 단순 제거).
4. 소비자 영향 확인: `src/App.tsx` Esc 핸들러, `src/lib/useCmdKnob.ts` — 시그니처 `isOverlayOpen()` 무변경이라 무손상.
5. 테스트(§5).
6. 회귀 스모크: Dialog/Select/Dropdown Esc로 셸 창 숨김 양보 유지(§6 계약), worktree에서 knob 표시,
   board CardMenu/BrainDump 열림 시 knob 억제 + Esc 닫힘.

## 5. 테스트 전략 (핵심 결정)

현 `vitest.config.ts` = `environment: "node"` → `document` 없음. DOM 단일 진실원은 DOM 테스트가 필요.

- **옵션 A**: `jsdom`/`happy-dom` 도입(per-file `// @vitest-environment jsdom` 또는 config 분기).
  overlay-stack/knob의 실제 DOM 동작을 단위 테스트로 잠금. (devDep 추가 = 스코프↑, 하지만 향후 RTL 발판.)
- **옵션 B**: jsdom 없이 — `isOverlayOpen`에 querySelector를 주입 가능하게(작은 seam) 두고 fake로 테스트.
- 기존 `src/components/ui/overlay-stack.test.ts`(카운터 기반)는 카운터 제거 시 **재작성/삭제** 필요.

권장: 옵션 A(jsdom) — 이 클래스 버그(DOM/effect 동기화)는 node 단위 테스트로 못 잡는 게 이번에 증명됨.

## 6. 계약·위험

- **Esc 타이밍 계약(plan §0.6)**: 사용자가 Esc로 오버레이를 닫을 때, radix close→unmount는 React
  커밋 이후라 **window로 Esc가 버블되는 시점엔 오버레이 DOM이 아직 살아있다** → `isOverlayOpen()`이
  true 반환 → 셸이 창 숨김 양보. DOM 단일 진실원에서도 이 타이밍은 유지됨(검증 필요 — 회귀 스모크).
- **false-negative 위험(마커 누락)**: 어떤 오버레이가 마커를 안 달면 isOverlayOpen이 놓침 → 셸이
  창을 숨기거나 knob이 뜸. 통일 마커 채택 시 "열림=마커" 컨벤션을 area 문서에 못박아 재발 방지.
- **prod vs dev**: over-count drift는 주로 dev StrictMode 현상 — prod에선 기존 카운터도 대체로 정상이었음.
  그래도 DOM 단일 진실원은 양쪽 모두 견고 + 코드 단순화라 가치 있음.

## 7. 비목표

- 오버레이 시스템 자체(radix/shadcn) 교체 — 아님.
- knob 동작 변경 — 아님(이미 수정됨).
- 한 PR에 기능 추가 섞기 — 금지(이건 순수 코드 헬스 리팩터).
