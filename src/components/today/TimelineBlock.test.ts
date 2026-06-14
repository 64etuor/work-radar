import { describe, expect, it } from "vitest";

import {
  resizeHandleHeightPx,
  showTopHandle,
  timelineBlockPlacementStyle,
} from "./timelineBlockStyle";

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
  it("returns a steady 8px hitbox (Bug fix 2026-06-14: the old 3px floor was ungrabbable)", () => {
    // timelineLayout floors block heights to MIN_BLOCK_PX=20; short blocks drop the TOP
    // handle (showTopHandle) instead of shrinking the band, so 8px never eats the move band.
    expect(resizeHandleHeightPx()).toBe(8);
  });
});

describe("showTopHandle", () => {
  it("renders both handles only when a usable move band fits (>=28px)", () => {
    expect(showTopHandle(28)).toBe(true);
    expect(showTopHandle(36)).toBe(true);
    expect(showTopHandle(60)).toBe(true);
  });

  it("drops the top handle on short blocks so the whole body stays grabbable for move", () => {
    // 8px handle + 8px handle + >=12px move band = 28px. Below that => single bottom handle.
    // timelineLayout floors heights to 20px, so 20..27px is the real single-handle range.
    expect(showTopHandle(27)).toBe(false);
    expect(showTopHandle(20)).toBe(false);
  });
});
