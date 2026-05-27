import { describe, expect, it } from "vitest";

import { timelineBlockPlacementStyle } from "./timelineBlockStyle";

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
