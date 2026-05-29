// 열린 오버레이 감지. App 셸의 Esc→window.hide() 양보 + Cmd-Knob 표시 억제가 참조한다.
//
// 단일 진실원 = DOM. 모든 오버레이는 열린 동안 자기 콘텐츠 루트에 `data-wr-overlay-open` 마커를 단다
// (radix Dialog/Select Content, bespoke CommitGraphDrawer/CardMenu/BrainDumpToggle). isOverlayOpen은
// 그 마커를 한 번 쿼리할 뿐 — 수동 카운터가 없으니 drift(over/under-count) 원천이 없다.
//
// 과거엔 모듈 전역 정수 카운터(registerOverlay/openCount)로 부수효과를 손으로 셌는데, React dev
// StrictMode의 effect reconnect(이중 마운트) + radix 마운트 churn으로 카운트가 비대칭 집계돼 실제로
// 열린 오버레이가 없는데도 >0이 고착되는 케이스가 있었다(뷰 전환이 잦은 worktree에서 knob 영구 억제).
// DOM은 닫히면 콘텐츠가 사라지므로 그 한 클래스의 버그가 구조적으로 불가능해진다.
//
// Esc 타이밍 계약(shadcn-migration.md §radix Dialog Esc 계약): radix close→unmount 정리는 React
// 커밋 이후라, native Esc가 window로 버블되는 시점엔 오버레이 DOM이 아직 살아있다 → isOverlayOpen()이
// true → 셸이 창 숨김을 양보한다.

/** 모든 오버레이가 열린 동안 콘텐츠 루트에 다는 공통 "열림" 마커 속성. 새 오버레이는 이 속성만 달면 된다. */
export const OVERLAY_OPEN_ATTR = "data-wr-overlay-open";

/** 현재 실제로 열린 오버레이가 하나라도 있는가. 비-DOM(test/node) 환경은 false. */
export function isOverlayOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector(`[${OVERLAY_OPEN_ATTR}]`) !== null;
}
