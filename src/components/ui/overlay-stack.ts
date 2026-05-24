// 열린 radix 오버레이(Dialog/DropdownMenu/Select) 카운트 레지스트리.
//
// 상호작용 계약(plan §0.6): App.tsx의 window(bubble) Esc 리스너는 Esc 시 `getCurrentWindow().hide()`를
// 호출한다. radix 오버레이가 열려 있는 동안에는 셸이 그 동작을 양보해야 한다 — radix가 Esc로 최상위
// 레이어를 닫고 포커스를 트리거로 복원하는 일을 전담하고, 셸은 단지 창을 숨기지 않는다.
//
// radix content는 열렸을 때만 마운트되므로 각 content의 effect가 mount=push / unmount=pop 한다.
// 카운트(>0)는 중첩(예: Dialog 안 Select)도 안전하게 커버한다. unmount 정리는 React 커밋 이후라
// native Esc가 window로 버블되는 시점엔 카운트가 아직 >0다(셸이 올바르게 양보).

let openCount = 0;

/** 오버레이 열림 등록. 반환된 함수를 호출(또는 effect cleanup)하면 해제된다. */
export function registerOverlay(): () => void {
  openCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount = Math.max(0, openCount - 1);
  };
}

/** 현재 열린 radix 오버레이가 하나라도 있는가. App 셸 Esc 핸들러가 참조. */
export function isOverlayOpen(): boolean {
  return openCount > 0;
}
