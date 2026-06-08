import { describe, expect, it } from "vitest";

import { buildTodayBlocks, eventBlockApiId } from "./todayBlocks";

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

  it("synced routine renders as the calendar event with a local routine checkbox target", () => {
    const routines = [
      {
        id: "r1",
        title: "R",
        timeOfDay: "09:00",
        timeOverride: null,
        linkedEventId: null,
        linkedCalendarId: null,
        googleEventId: "master-1",
        googleCalendarId: "work-cal",
        done: true,
      },
    ] as never[];
    const events = [
      {
        id: "master-1",
        title: "R",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T09:30:00",
        allDay: false,
        calendarId: "work-cal",
        calendarSummary: "업무",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events, routines, date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("event:work-cal:master-1");
    expect(blocks[0].kind).toBe("event");
    expect(blocks[0].linkedEventId).toBe("master-1");
    expect(blocks[0].calendarId).toBe("work-cal");
    expect(blocks[0].routineId).toBe("r1");
    expect(blocks[0].done).toBe(true);
  });

  it("synced recurring routine instance uses recurringEventId as the checkbox target", () => {
    const routines = [
      {
        id: "r1",
        title: "R",
        timeOfDay: "09:00",
        timeOverride: null,
        linkedEventId: null,
        linkedCalendarId: null,
        googleEventId: "master-1",
        googleCalendarId: "work-cal",
        done: false,
      },
    ] as never[];
    const events = [
      {
        id: "master-1_20260528T000000Z",
        recurringEventId: "master-1",
        title: "R",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T09:30:00",
        allDay: false,
        calendarId: "work-cal",
        calendarSummary: "업무",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], events, routines, date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("event:work-cal:master-1_20260528T000000Z");
    expect(blocks[0].kind).toBe("event");
    expect(blocks[0].linkedEventId).toBe("master-1_20260528T000000Z");
    expect(blocks[0].routineId).toBe("r1");
    expect(blocks[0].done).toBe(false);
  });

  it("synced routine without a fetched calendar event does not render a routine job block", () => {
    const routines = [
      {
        id: "r1",
        title: "R",
        timeOfDay: "09:00",
        timeOverride: null,
        googleEventId: "master-1",
        googleCalendarId: "work-cal",
      },
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

describe("eventBlockApiId", () => {
  // 회귀: 복합 블록 id(`event:${calendarId}:${eventId}`)에서 `event:`만 떼면 calendarId가 남아
  // Google events.patch가 404를 낸다(드래그/리사이즈가 롤백됨). bare eventId를 정확히 뽑아야 한다.
  it("returns the bare google event id from a composite event block", () => {
    expect(
      eventBlockApiId({
        id: "event:64etuor@gmail.com:6205deofmq46okqu42tgekmno0",
        calendarId: "64etuor@gmail.com",
        linkedEventId: "6205deofmq46okqu42tgekmno0",
      }),
    ).toBe("6205deofmq46okqu42tgekmno0");
  });

  it("falls back to stripping the composite prefix when linkedEventId is absent", () => {
    expect(
      eventBlockApiId({
        id: "event:team@group.calendar.google.com:abc123",
        calendarId: "team@group.calendar.google.com",
      }),
    ).toBe("abc123");
  });

  it("never leaves the calendarId prefix on the api id", () => {
    const id = eventBlockApiId({
      id: "event:cal-x:evt-y",
      calendarId: "cal-x",
    });
    expect(id).toBe("evt-y");
    expect(id).not.toContain("cal-x");
    expect(id).not.toContain(":");
  });
});
