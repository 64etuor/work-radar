// Pure-helper tests only. The TanStack Query / debounce wiring is
// exercised via manual smoke in Phase A4/D4 (no jsdom in this project).
import { describe, expect, it } from "vitest";

import { DEFAULT_PANEL_STATE, mergeBounds } from "./useHermesPanelState";

describe("mergeBounds", () => {
  it("preserves unchanged fields", () => {
    const s = { x: 10, y: 20, w: 300, h: 400, open: true };
    const result = mergeBounds(s, {});
    expect(result).toEqual(s);
  });

  it("applies provided x/y", () => {
    const s = { x: 10, y: 20, w: 300, h: 400, open: false };
    const result = mergeBounds(s, { x: 99, y: 88 });
    expect(result.x).toBe(99);
    expect(result.y).toBe(88);
    expect(result.w).toBe(300);
    expect(result.h).toBe(400);
    expect(result.open).toBe(false);
  });

  it("applies provided w/h", () => {
    const s = { x: 10, y: 20, w: 300, h: 400, open: false };
    const result = mergeBounds(s, { w: 500, h: 700 });
    expect(result.x).toBe(10);
    expect(result.y).toBe(20);
    expect(result.w).toBe(500);
    expect(result.h).toBe(700);
    expect(result.open).toBe(false);
  });

  it("applied to default state yields default + delta", () => {
    const result = mergeBounds(DEFAULT_PANEL_STATE, { x: 50, w: 800 });
    expect(result).toEqual({
      x: 50,
      y: DEFAULT_PANEL_STATE.y,
      w: 800,
      h: DEFAULT_PANEL_STATE.h,
      open: DEFAULT_PANEL_STATE.open,
    });
  });
});
