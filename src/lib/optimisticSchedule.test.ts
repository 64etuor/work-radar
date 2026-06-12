/**
 * Today×Timeline Optimistic 패치 헬퍼 테스트(PR 5 + Task 8).
 *
 * 순수 함수 — DnD 한 번에 캐시(WorkSignal[] / SignalDayPlacement[])를 즉시 갱신하고,
 * sync 실패 시 원본으로 되돌린다.
 */
import { describe, expect, it } from "vitest";

import type { SignalDayPlacement, WorkSignal } from "@/bindings";

import {
  applyPlacementPatch,
  applySchedulePatch,
  rollbackSchedulePatch,
} from "./optimisticSchedule";

function mkSignal(partial: Partial<WorkSignal> & { id: string }): WorkSignal {
  // 테스트 fixture — 필수 필드만 채우고 나머지는 type assertion으로 좁힌다.
  return {
    id: partial.id,
    title: partial.title ?? "t",
    scheduledAt: partial.scheduledAt ?? null,
    scheduledDuration: partial.scheduledDuration ?? null,
    linkedEventId: partial.linkedEventId ?? null,
    linkedCalendarId: partial.linkedCalendarId ?? null,
  } as unknown as WorkSignal;
}

describe("applySchedulePatch", () => {
  it("patches scheduledAt + duration of a single signal", () => {
    const sigs = [mkSignal({ id: "s1" }), mkSignal({ id: "s2" })];
    const next = applySchedulePatch(sigs, "s1", {
      at: "2026-05-28T09:00:00",
      durationMin: 60,
    });
    const patched = next.find((s) => s.id === "s1");
    const untouched = next.find((s) => s.id === "s2");
    expect(patched?.scheduledAt).toBe("2026-05-28T09:00:00");
    expect(patched?.scheduledDuration).toBe(60);
    expect(untouched?.scheduledAt).toBeNull();
  });

  it("patches linkedCalendarId when provided", () => {
    const sigs = [mkSignal({ id: "s1", linkedCalendarId: "old" })];
    const next = applySchedulePatch(sigs, "s1", { calendarId: "new" });
    expect(next[0].linkedCalendarId).toBe("new");
  });

  it("clears at + duration when clearLink", () => {
    const sigs = [
      mkSignal({
        id: "s1",
        scheduledAt: "2026-05-28T10:00:00",
        scheduledDuration: 45,
        linkedEventId: "evt",
        linkedCalendarId: "cal",
      }),
    ];
    const next = applySchedulePatch(sigs, "s1", { clearLink: true });
    expect(next[0].scheduledAt).toBeNull();
    expect(next[0].scheduledDuration).toBeNull();
    expect(next[0].linkedEventId).toBeNull();
    expect(next[0].linkedCalendarId).toBeNull();
  });

  it("returns same identity for unmatched ids (no spurious churn)", () => {
    const sigs = [mkSignal({ id: "s1" })];
    const next = applySchedulePatch(sigs, "missing", { at: "X", durationMin: 1 });
    expect(next[0]).toBe(sigs[0]);
  });
});

describe("rollbackSchedulePatch", () => {
  it("restores prior state for the patched id only", () => {
    const orig = [
      mkSignal({ id: "s1", scheduledAt: "X", scheduledDuration: 30 }),
      mkSignal({ id: "s2", scheduledAt: "Y", scheduledDuration: 15 }),
    ];
    const patched = applySchedulePatch(orig, "s1", { at: "Z", durationMin: 90 });
    const back = rollbackSchedulePatch(patched, "s1", orig);
    expect(back.find((s) => s.id === "s1")?.scheduledAt).toBe("X");
    expect(back.find((s) => s.id === "s1")?.scheduledDuration).toBe(30);
    // s2는 그대로 (rollback 영향 없음).
    expect(back.find((s) => s.id === "s2")?.scheduledAt).toBe("Y");
  });

  it("noops when original snapshot missing the id", () => {
    const orig = [mkSignal({ id: "s1" })];
    const current = [mkSignal({ id: "s1", scheduledAt: "patched" })];
    const back = rollbackSchedulePatch(current, "missing", orig);
    expect(back).toBe(current);
  });
});

// ── applyPlacementPatch ──────────────────────────────────────────────────────

function mkPlacement(
  partial: Partial<SignalDayPlacement> & { signalId: string; date: string },
): SignalDayPlacement {
  return {
    id: partial.id ?? `p:${partial.signalId}:${partial.date}`,
    signalId: partial.signalId,
    date: partial.date,
    startAt: partial.startAt ?? `${partial.date}T09:00:00`,
    durationMin: partial.durationMin ?? 60,
  };
}

describe("applyPlacementPatch", () => {
  it("upsert replaces same (signal, date) row", () => {
    const existing = mkPlacement({
      signalId: "s1",
      date: "2026-06-10",
      startAt: "2026-06-10T08:00:00",
      durationMin: 30,
    });
    const other = mkPlacement({ signalId: "s1", date: "2026-06-11" });
    const result = applyPlacementPatch([existing, other], "s1", {
      type: "upsert",
      date: "2026-06-10",
      startAt: "2026-06-10T10:00:00",
      durationMin: 90,
    });
    // old row for 2026-06-10 gone, new row present
    const row = result.find((p) => p.signalId === "s1" && p.date === "2026-06-10");
    expect(result.length).toBe(2);
    expect(row?.startAt).toBe("2026-06-10T10:00:00");
    expect(row?.durationMin).toBe(90);
    // other date untouched
    expect(result.find((p) => p.date === "2026-06-11")).toBeDefined();
  });

  it("move removes fromDate row and adds new date row", () => {
    const p = mkPlacement({ signalId: "s1", date: "2026-06-10" });
    const result = applyPlacementPatch([p], "s1", {
      type: "move",
      fromDate: "2026-06-10",
      date: "2026-06-12",
      startAt: "2026-06-12T11:00:00",
      durationMin: 45,
    });
    expect(result.find((r) => r.date === "2026-06-10")).toBeUndefined();
    const moved = result.find((r) => r.date === "2026-06-12");
    expect(moved?.startAt).toBe("2026-06-12T11:00:00");
    expect(moved?.durationMin).toBe(45);
  });

  it("remove deletes only that date row — other dates preserved", () => {
    const p1 = mkPlacement({ signalId: "s1", date: "2026-06-10" });
    const p2 = mkPlacement({ signalId: "s1", date: "2026-06-11" });
    const result = applyPlacementPatch([p1, p2], "s1", { type: "remove", date: "2026-06-10" });
    expect(result.find((r) => r.date === "2026-06-10")).toBeUndefined();
    expect(result.find((r) => r.date === "2026-06-11")).toBeDefined();
  });

  it("other signals are unaffected by any patch", () => {
    const p1 = mkPlacement({ signalId: "s1", date: "2026-06-10" });
    const p2 = mkPlacement({ signalId: "s2", date: "2026-06-10" });
    const result = applyPlacementPatch([p1, p2], "s1", { type: "remove", date: "2026-06-10" });
    expect(result.find((r) => r.signalId === "s2")).toBeDefined();
    expect(result.find((r) => r.signalId === "s1")).toBeUndefined();
  });
});
