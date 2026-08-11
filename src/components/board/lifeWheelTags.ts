/** 신호의 area 태그 키 배열 해석. areaTags(JSON 배열) 우선, 없으면 primary area 단일. 공용. */
export function parseAreaTagKeys(raw: string | null, primary: string | null): string[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Fall back to primary tag below.
    }
  }
  return primary ? [primary] : [];
}

/**
 * 방사형 팔레트 앵커를 뷰포트 안으로 클램프 — 휠(outerRadius 124 + 라벨)이 화면 밖으로
 * 잘려 세그먼트가 클릭 불가능해지는 것을 막는다. 모든 팔레트 열기 지점이 공유한다.
 */
export function clampPaletteAnchor(rect: DOMRect): { x: number; y: number } {
  // 뷰포트가 2×margin보다 작으면 min/max가 역전돼 화면 밖으로 밀리므로 margin을 축소.
  const marginX = Math.min(156, window.innerWidth / 2);
  const marginY = Math.min(156, window.innerHeight / 2);
  return {
    x: Math.min(Math.max(rect.left + rect.width / 2, marginX), window.innerWidth - marginX),
    y: Math.min(Math.max(rect.top + rect.height / 2, marginY), window.innerHeight - marginY),
  };
}
