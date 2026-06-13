import { describe, expect, it } from "vitest";

import { resizeHandleHeightPx, timelineBlockPlacementStyle } from "./timelineBlockStyle";

describe("timelineBlockPlacementStyle", () => {
  it("uses CSS-safe percentages for split overlap placement", () => {
    const style = timelineBlockPlacementStyle({
      topPx: 540,
      heightPx: 60,
      leftPct: 50,
      widthPct: 50,
      dragging: false,
      translate: null,
    });

    expect(style.left).toBe("50%");
    expect(style.width).toBe("calc(50% - 4px)");
    expect(style.transform).toBeUndefined();
    expect(`${style.left} ${style.width}`).not.toMatch(/[*/]/);
  });

  it("moves the actual block with dnd translate while dragging", () => {
    const style = timelineBlockPlacementStyle({
      topPx: 540,
      heightPx: 60,
      leftPct: 0,
      widthPct: 100,
      dragging: true,
      translate: { x: 40, y: 30 },
    });

    expect(style.transform).toBe("translate3d(40px, 30px, 0)");
  });

  it("turns off layout transition while resize preview owns height", () => {
    const style = timelineBlockPlacementStyle({
      topPx: 540,
      heightPx: 120,
      leftPct: 0,
      widthPct: 100,
      dragging: false,
      translate: null,
      disableLayoutTransition: true,
    });

    expect(style.height).toBe("120px");
    expect(style.transition).toBe("none");
    expect(style.willChange).toBe("auto");
  });
});

describe("resizeHandleHeightPx", () => {
  it("shrinks the resize hitbox on short blocks to preserve a center move band (Bug 1a)", () => {
    // 최소 블록(20px = 15분) → 3px 핸들 → 중앙 14px가 move로 잡힘.
    expect(resizeHandleHeightPx(20)).toBe(3);
    // 30분(30px) → 5px.
    expect(resizeHandleHeightPx(30)).toBe(5);
    // 36px 이상은 풀사이즈 8px.
    expect(resizeHandleHeightPx(36)).toBe(8);
    expect(resizeHandleHeightPx(60)).toBe(8);
  });

  it("clamps to the [3, 8] range", () => {
    // 20px 미만(이론상)에서도 최소 3px 유지.
    expect(resizeHandleHeightPx(10)).toBe(3);
    // 아주 큰 블록도 8px 상한.
    expect(resizeHandleHeightPx(600)).toBe(8);
  });
});
