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
        linkedCalendarId: "cal-id",
      },
    ] as never[];
    const events = [
      {
        id: "g1",
        title: "G",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarId: "cal-id",
        calendarSummary: "cal",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, events, routines: [], date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("signal");
  });

  it("signal link only absorbs event when calendarId also matches", () => {
    const signals = [
      {
        id: "s1",
        title: "S",
        scheduledAt: "2026-05-28T09:00:00",
        scheduledDuration: 60,
        linkedEventId: "g1",
        linkedCalendarId: "cal-a",
      },
    ] as never[];
    const events = [
      {
        id: "g1",
        title: "G",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarId: "cal-b",
        calendarSummary: "cal b",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, events, routines: [], date: DATE });
    expect(blocks.map((b) => b.kind)).toEqual(["signal", "event"]);
  });

  it("google event without linked signal renders as event kind", () => {
    const events = [
      {
        id: "g1",
        title: "G",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarId: "cal-id",
        calendarSummary: "cal",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events, routines: [], date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("event");
    expect(blocks[0].calendarId).toBe("cal-id");
    expect(blocks[0].calendarLabel).toBe("cal");
    expect(blocks[0].linkedEventId).toBe("g1");
  });

  it("events with same event id in different calendars keep distinct block ids", () => {
    const events = [
      {
        id: "g1",
        title: "G A",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarId: "cal-a",
        calendarSummary: "cal a",
        projectColor: "#444",
      },
      {
        id: "g1",
        title: "G B",
        start: "2026-05-28T10:00:00",
        end: "2026-05-28T11:00:00",
        allDay: false,
        calendarId: "cal-b",
        calendarSummary: "cal b",
        projectColor: "#555",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events, routines: [], date: DATE });
    expect(blocks).toHaveLength(2);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(2);
  });

  it("all-day events are excluded from blocks", () => {
    const events = [
      {
        id: "g1",
        title: "All day",
        start: "2026-05-28",
        end: "2026-05-29",
        allDay: true,
        calendarId: "cal-id",
        calendarSummary: "cal",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events, routines: [], date: DATE });
    expect(blocks).toHaveLength(0);
  });

  it("routine with timeOfDay produces virtual instance", () => {
    const routines = [{ id: "r1", title: "R", timeOfDay: "07:00", timeOverride: null }] as never[];
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
    const routines = [{ id: "r1", title: "R", timeOfDay: null, timeOverride: null }] as never[];
    const blocks = buildTodayBlocks({ signals: [], events: [], routines, date: DATE });
    expect(blocks).toHaveLength(0);
  });

  it("routine without rendered time does not absorb its google event", () => {
    const routines = [
      {
        id: "r1",
        title: "R",
        timeOfDay: null,
        timeOverride: null,
        linkedEventId: "g1",
        linkedCalendarId: "cal-a",
      },
    ] as never[];
    const events = [
      {
        id: "g1",
        title: "G",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarId: "cal-a",
        calendarSummary: "cal a",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events, routines, date: DATE });
    expect(blocks.map((b) => b.kind)).toEqual(["event"]);
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
