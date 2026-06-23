/**
 * useTimelinePointerDelta — freeze-regression + operation-delta tests.
 *
 * Tests the pure exported helpers (computeMoveDelta, computeGridPoint) that
 * encode the fix: OPERATION delta comes from dnd-kit's ev.delta (always fresh),
 * NOT from the hand-rolled raw-pointer ref (which can go stale → freeze).
 * Raw pointer is used only for crosshair cursor position (pointerGrid).
 */
import { describe, expect, it } from "vitest";

import { computeGridPoint, computeMoveDelta } from "./useTimelinePointerDelta";

/** Mock grid rect used across tests. */
const MOCK_RECT = { left: 100, top: 100, width: 520 };

// ── Freeze regression ────────────────────────────────────────────────────────
describe("computeMoveDelta — freeze regression", () => {
  it("returns increasing delta.y when evDelta increases, even with a STALE raw pointer ref", () => {
    // Raw pointer is set once and never updated — simulates the listener-lag/freeze scenario.
    const staleRawPointer = { x: 220, y: 520 };

    const r1 = computeMoveDelta({ x: 0, y: -20 }, staleRawPointer, MOCK_RECT, 1);
    const r2 = computeMoveDelta({ x: 0, y: -40 }, staleRawPointer, MOCK_RECT, 1);
    const r3 = computeMoveDelta({ x: 0, y: -60 }, staleRawPointer, MOCK_RECT, 1);

    // Operation delta must track evDelta, NOT freeze at the stale grid-point diff.
    expect(r1.delta.y).toBe(-20);
    expect(r2.delta.y).toBe(-40);
    expect(r3.delta.y).toBe(-60);
  });

  it("delta.x also tracks evDelta x component independently of raw pointer", () => {
    const stalePointer = { x: 220, y: 520 };
    const { delta } = computeMoveDelta({ x: 30, y: -50 }, stalePointer, MOCK_RECT, 1);
    expect(delta.x).toBe(30);
    expect(delta.y).toBe(-50);
  });
});

// ── Operation delta equals ev.delta ─────────────────────────────────────────
describe("computeMoveDelta — operation delta equals evDelta", () => {
  it("returns delta === evDelta values", () => {
    const evDelta = { x: 5, y: -75 };
    const { delta } = computeMoveDelta(evDelta, { x: 220, y: 600 }, MOCK_RECT, 1);
    expect(delta).toEqual(evDelta);
  });

  it("returns delta even when raw pointer is null", () => {
    const evDelta = { x: 0, y: -100 };
    const { delta } = computeMoveDelta(evDelta, null, MOCK_RECT, 1);
    expect(delta).toEqual(evDelta);
  });

  it("returns delta even when rect is null (no grid el mounted)", () => {
    const evDelta = { x: 0, y: -55 };
    const { delta } = computeMoveDelta(evDelta, { x: 220, y: 500 }, null, 1);
    expect(delta).toEqual(evDelta);
  });
});

// ── Crosshair still from raw pointer (independent of ev.delta) ───────────────
describe("computeMoveDelta — crosshair (pointerGrid) from raw pointer only", () => {
  it("pointerGrid is non-null when raw pointer is inside the grid rect", () => {
    const { pointerGrid } = computeMoveDelta(
      { x: 999, y: 999 }, // evDelta is irrelevant for crosshair
      { x: 220, y: 700 }, // raw pointer inside MOCK_RECT (left:100,top:100,w:520)
      MOCK_RECT,
      1,
    );
    expect(pointerGrid).not.toBeNull();
  });

  it("pointerGrid changes when raw pointer moves, regardless of evDelta", () => {
    const evDelta = { x: 999, y: 999 }; // same evDelta both times

    const { pointerGrid: pg1 } = computeMoveDelta(evDelta, { x: 220, y: 700 }, MOCK_RECT, 1);
    const { pointerGrid: pg2 } = computeMoveDelta(evDelta, { x: 220, y: 900 }, MOCK_RECT, 1);

    // Moving raw pointer down increases grid Y.
    expect(pg2!.y).toBeGreaterThan(pg1!.y);
  });

  it("pointerGrid is null when raw pointer is null", () => {
    const { pointerGrid } = computeMoveDelta({ x: 0, y: 0 }, null, MOCK_RECT, 1);
    expect(pointerGrid).toBeNull();
  });

  it("pointerGrid is null when rect is null", () => {
    const { pointerGrid } = computeMoveDelta({ x: 0, y: 0 }, { x: 220, y: 500 }, null, 1);
    expect(pointerGrid).toBeNull();
  });
});

// ── computeGridPoint standalone ───────────────────────────────────────────────
describe("computeGridPoint", () => {
  it("returns null when point is null", () => {
    expect(computeGridPoint(null, MOCK_RECT, 1)).toBeNull();
  });

  it("returns null when rect is null", () => {
    expect(computeGridPoint({ x: 220, y: 500 }, null, 1)).toBeNull();
  });

  it("returns a grid coordinate for a valid point inside the rect", () => {
    const result = computeGridPoint({ x: 220, y: 500 }, MOCK_RECT, 1);
    expect(result).not.toBeNull();
    expect(typeof result!.x).toBe("number");
    expect(typeof result!.y).toBe("number");
  });
});
