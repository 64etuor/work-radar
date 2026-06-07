export interface MenuPosition {
  /** 메뉴 가로 중심 x(레버 origin.x에 맞춤, 화면 외곽이면 clamp). 적용 시 transform: translateX(-50%)와 함께. */
  centerX: number;
  top: number;
  placement: "above" | "below";
}

/**
 * Cmd 페이지 메뉴의 화면 위치 계산(순수). 가로는 메뉴 중심을 레버 origin.x에 맞추고(공간이
 * 충분할 때) 화면 외곽이면 박스가 margin 안에 들어오도록 중심을 clamp한다 — 중심을 돌려주고
 * 실제 렌더 폭 기준 정렬은 CSS translateX(-50%)가 하므로 측정 오차에 영향받지 않는다.
 * 세로는 레버 아래쪽(below)에 살짝 띄움 — 아래 공간이 부족하면 위(above)로 flip, 항상 뷰포트 안.
 * margin = 뷰포트 가장자리 최소 여백, clearance = origin(레버 중심)에서 메뉴까지 띄울 간격.
 */
export function clampMenuPosition(
  origin: { x: number; y: number },
  viewport: { w: number; h: number },
  menu: { w: number; h: number },
  margin: number,
  clearance: number,
): MenuPosition {
  const half = menu.w / 2;
  const minCenter = margin + half;
  const maxCenter = viewport.w - margin - half;
  // 메뉴가 뷰포트보다 넓으면(minCenter>maxCenter) 중심을 뷰포트 중앙으로 — 좌우 균등 오버플로.
  const centerX =
    minCenter > maxCenter ? viewport.w / 2 : Math.min(Math.max(origin.x, minCenter), maxCenter);

  const belowTop = origin.y + clearance;
  let placement: "above" | "below";
  let top: number;
  if (belowTop + menu.h <= viewport.h - margin) {
    placement = "below";
    top = belowTop;
  } else {
    placement = "above";
    top = origin.y - clearance - menu.h;
  }
  const maxTop = Math.max(margin, viewport.h - menu.h - margin);
  top = Math.min(Math.max(top, margin), maxTop);

  return { centerX, top, placement };
}
