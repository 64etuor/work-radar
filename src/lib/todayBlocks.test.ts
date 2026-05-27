import { describe, expect, it } from "vitest";
import { buildTodayBlocks } from "./todayBlocks";

const DATE = "2026-05-28";

describe("buildTodayBlocks", () => {
  it("signal with linkedEventId absorbs matching google event", () => {
    const signals = [
      {
        id: "s1",
        title: "S",
        scheduledAt: "2026-05-28T09:00:00",
        scheduledDuration: 60,
        linkedEventId: "g1",
        linkedCalendarId: "cal",
      },
    ] as never[];
    const events = [
      {
        id: "g1",
        title: "G",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarSummary: "cal",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, events, routines: [], date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("signal");
  });

  it("google event without linked signal renders as event kind", () => {
    const events = [
      {
        id: "g1",
        title: "G",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarSummary: "cal",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events, routines: [], date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("event");
  });

  it("all-day events are excluded from blocks", () => {
    const events = [
      {
        id: "g1",
        title: "All day",
        start: "2026-05-28",
        end: "2026-05-29",
        allDay: true,
        calendarSummary: "cal",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events, routines: [], date: DATE });
    expect(blocks).toHaveLength(0);
  });

  it("routine with timeOfDay produces virtual instance", () => {
    const routines = [
      { id: "r1", title: "R", timeOfDay: "07:00", timeOverride: null },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events: [], routines, date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("routine");
    expect(blocks[0].startISO).toContain("07:00");
  });

  it("routine timeOverride wins over timeOfDay", () => {
    const routines = [
      { id: "r1", title: "R", timeOfDay: "07:00", timeOverride: "09:00" },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events: [], routines, date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startISO).toContain("09:00");
  });

  it("routine without any time is skipped", () => {
    const routines = [
      { id: "r1", title: "R", timeOfDay: null, timeOverride: null },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events: [], routines, date: DATE });
    expect(blocks).toHaveLength(0);
  });

  it("plusMin preserves local time across hour boundary (no UTC drift)", () => {
    const signals = [
      {
        id: "s1",
        title: "S",
        scheduledAt: "2026-05-28T23:30:00",
        scheduledDuration: 60,
        linkedEventId: null,
        linkedCalendarId: null,
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, events: [], routines: [], date: DATE });
    // local 00:30 다음날, NOT 15:30Z(UTC). `.toISOString()` 회귀 차단.
    expect(blocks[0].endISO).toMatch(/^2026-05-29T00:30:00/);
    // 로컬 포맷 보존 확인 — 'Z' 접미사 금지.
    expect(blocks[0].endISO.endsWith("Z")).toBe(false);
  });

  it("signal without scheduledAt is skipped (unscheduled)", () => {
    const signals = [
      {
        id: "s1",
        title: "S",
        scheduledAt: null,
        scheduledDuration: null,
        linkedEventId: null,
        linkedCalendarId: null,
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, events: [], routines: [], date: DATE });
    expect(blocks).toHaveLength(0);
  });
});
