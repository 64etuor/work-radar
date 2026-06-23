import { describe, expect, it } from "vitest";

import { synthesizeGuideX } from "./timelineGuide";

describe("synthesizeGuideX", () => {
  it("centers x within the block layer (gutter + width/2), no delta", () => {
    // gridWidth 660 → layerWidth 600; full-width block at left 0:
    // left = 60, width = 600 - 4 = 596, centerX = 60 + 298 = 358.
    const x = synthesizeGuideX({ leftPct: 0, widthPct: 100, gridWidth: 660, deltaX: 0 });
    expect(x).toBe(358);
    // within [60, gridWidth]
    expect(x).toBeGreaterThanOrEqual(60);
    expect(x).toBeLessThanOrEqual(660);
  });

  it("applies the -4px right inset (vs naive half-width)", () => {
    // Without the -4 inset, full-width center would be 60 + 600/2 = 360.
    // The inset shaves 2px off the center → 358.
    const inset = synthesizeGuideX({ leftPct: 0, widthPct: 100, gridWidth: 660, deltaX: 0 });
    expect(inset).toBe(358);
    expect(360 - inset).toBe(2);
  });

  it("shifts by +deltaX", () => {
    const base = synthesizeGuideX({ leftPct: 0, widthPct: 100, gridWidth: 660, deltaX: 0 });
    const shifted = synthesizeGuideX({ leftPct: 0, widthPct: 100, gridWidth: 660, deltaX: 25 });
    expect(shifted).toBe(base + 25);
  });

  it("clamps to gridWidth at the right edge (large +delta)", () => {
    const x = synthesizeGuideX({ leftPct: 100, widthPct: 100, gridWidth: 660, deltaX: 5000 });
    expect(x).toBe(660);
  });

  it("clamps to the 60px gutter at the left edge (large -delta)", () => {
    const x = synthesizeGuideX({ leftPct: 0, widthPct: 50, gridWidth: 660, deltaX: -5000 });
    expect(x).toBe(60);
  });

  it("places a half-width second-column block in the right half", () => {
    // leftPct 50, widthPct 50, gridWidth 660 → layerWidth 600:
    // left = 60 + 300 = 360, width = 300 - 4 = 296, centerX = 360 + 148 = 508.
    const x = synthesizeGuideX({ leftPct: 50, widthPct: 50, gridWidth: 660, deltaX: 0 });
    expect(x).toBe(508);
  });
});
