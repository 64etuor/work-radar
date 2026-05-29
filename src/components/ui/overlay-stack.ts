// 열린 오버레이 감지. App 셸의 Esc→window.hide() 양보 + Cmd-Knob 표시 억제가 참조한다.
//
// registerOverlay/openCount는 "오버레이가 하나라도 등록됐는가"를 빠르게 거르는 게이트 신호다.
// 단, React dev StrictMode의 effect reconnect(이중 마운트) + radix 마운트 churn으로 카운트가
// 과다 집계(drift)돼 실제로 열린 오버레이가 없는데도 >0이 되는 케이스가 있었다 — 뷰 전환이 잦은
// worktree에서 isOverlayOpen()이 영구히 true가 돼 Cmd-Knob이 안 뜨고 셸 Esc 양보도 어긋났다.
// 그래서 최종 판정은 DOM 마커로 한다(drift-proof). radix content는 닫히면 DOM에서 사라지고,
// unmount 정리는 React 커밋 이후라 native Esc가 window로 버블되는 시점엔 오버레이 DOM이 아직
// 살아있다(셸이 올바르게 양보).

let openCount = 0;

/** 오버레이 열림 등록(게이트 신호). 반환된 함수를 호출(또는 effect cleanup)하면 해제된다. */
export function registerOverlay(): () => void {
  openCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount = Math.max(0, openCount - 1);
  };
}

// registerOverlay를 호출하는 모든 오버레이의 "열림" DOM 마커:
//   radix Dialog/AlertDialog → [role][data-state=open]
//   radix Select/Dropdown/Popover → [data-radix-popper-content-wrapper]
//   bespoke: CommitGraphDrawer(.wt-commit-drawer)/CardMenu(.cb-card-menu)/BrainDumpToggle
const OPEN_OVERLAY_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  ".wt-commit-drawer",
  ".cb-card-menu",
  '.brain-dump-toggle[data-state="open"]',
].join(", ");

/**
 * 현재 실제로 열린 오버레이가 하나라도 있는가. 카운터가 0이면 즉시 false, >0이면 DOM으로 확인한다
 * (등록은 됐지만 콘텐츠 DOM이 사라진 drift는 false). 비-DOM(test/node) 환경은 카운터로 폴백.
 */
export function isOverlayOpen(): boolean {
  if (openCount <= 0) return false;
  if (typeof document === "undefined") return true;
  return document.querySelector(OPEN_OVERLAY_SELECTOR) !== null;
}
