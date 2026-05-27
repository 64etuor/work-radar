import { describe, expect, it } from "vitest";
import { computeLayout, type TimedBlock } from "./timelineLayout";

const make = (
  id: string,
  start: string,
  end: string,
  kind: TimedBlock["kind"] = "event",
): TimedBlock => ({
  id,
  kind,
  title: id,
  startISO: start,
  endISO: end,
  calendarId: "c",
  color: "#888",
});

describe("computeLayout", () => {
  it("single block fills width", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", leftPct: 0, widthPct: 100 });
  });

  it("two non-overlapping each full width", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
      make("b", "2026-05-28T11:00:00", "2026-05-28T12:00:00"),
    ]);
    expect(out.find((b) => b.id === "a")!.widthPct).toBe(100);
    expect(out.find((b) => b.id === "b")!.widthPct).toBe(100);
  });

  it("two overlapping → 50/50", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:30:00"),
      make("b", "2026-05-28T10:00:00", "2026-05-28T11:00:00"),
    ]);
    expect(out.find((b) => b.id === "a")!.widthPct).toBe(50);
    expect(out.find((b) => b.id === "b")!.widthPct).toBe(50);
    expect(new Set(out.map((b) => b.leftPct))).toEqual(new Set([0, 50]));
  });

  it("three mutually overlapping → 33/33/33", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T11:00:00"),
      make("b", "2026-05-28T09:30:00", "2026-05-28T10:30:00"),
      make("c", "2026-05-28T10:00:00", "2026-05-28T11:30:00"),
    ]);
    for (const b of out) {
      expect(Math.abs(b.widthPct - 100 / 3)).toBeLessThan(0.01);
    }
    // 3 distinct columns
    expect(new Set(out.map((b) => Math.round(b.leftPct))).size).toBe(3);
  });

  it("cluster boundary: a-b overlap, c separate → cluster1=50/50, c=100", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
      make("b", "2026-05-28T09:30:00", "2026-05-28T10:30:00"),
      make("c", "2026-05-28T11:00:00", "2026-05-28T12:00:00"),
    ]);
    expect(out.find((x) => x.id === "a")!.widthPct).toBe(50);
    expect(out.find((x) => x.id === "b")!.widthPct).toBe(50);
    expect(out.find((x) => x.id === "c")!.widthPct).toBe(100);
  });

  it("topPx and heightPx derived from minutes (60px/hour)", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
    ]);
    expect(out[0].topPx).toBe(9 * 60);
    expect(out[0].heightPx).toBe(60);
  });
});
