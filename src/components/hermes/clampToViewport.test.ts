import { describe, expect, it } from "vitest";

import { clampToViewport } from "./clampToViewport";

describe("clampToViewport", () => {
  it("returns input unchanged when bounds are fully inside viewport", () => {
    const b = { x: 100, y: 100, w: 460, h: 600 };
    expect(clampToViewport(b, 1440, 900)).toEqual(b);
  });

  it("pulls panel back when it extends past the right edge", () => {
    // x=1000, w=460 → right edge = 1460 which exceeds vw=1440 → x should clamp to 1440-460=980
    const b = { x: 1000, y: 100, w: 460, h: 600 };
    const result = clampToViewport(b, 1440, 900);
    expect(result.x).toBe(980);
    expect(result.y).toBe(100);
  });

  it("clamps negative x to 0", () => {
    const b = { x: -50, y: 100, w: 460, h: 600 };
    const result = clampToViewport(b, 1440, 900);
    expect(result.x).toBe(0);
  });

  it("clamps height to viewport height", () => {
    const b = { x: 100, y: 0, w: 460, h: 1200 };
    const result = clampToViewport(b, 1440, 900);
    expect(result.h).toBe(900);
    expect(result.y).toBe(0);
  });
});
