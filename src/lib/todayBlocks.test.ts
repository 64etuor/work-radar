import { describe, expect, it } from "vitest";

import {
  blockNoteTarget,
  buildTodayBlocks,
  eventBlockApiId,
  noteTargetMapKey,
} from "./todayBlocks";

const DATE = "2026-05-28";

describe("buildTodayBlocks", () => {
  it("excludes scheduled signals whose date differs from the selected date", () => {
    // rollover 레일에는 다른 날짜로 배치된 signal이 남을 수 있다 — 보는 날짜와 다르면 제외돼야 한다.
    const signals = [
      {
        id: "today",
        title: "오늘 배치",
        scheduledAt: `${DATE}T09:00:00`,
        scheduledDuration: 60,
      },
      {
        id: "other",
        title: "다른날 배치",
        scheduledAt: "2026-05-29T09:00:00",
        scheduledDuration: 60,
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, events: [], routines: [], date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("signal:today");
  });

  it("keeps a signal scheduled with a local offset on the same local date", () => {
    const signals = [
      {
        id: "s1",
        title: "오프셋",
        scheduledAt: `${DATE}T23:30:00+09:00`,
        scheduledDuration: 30,
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, events: [], routines: [], date: DATE });
    expect(blocks).toHaveLength(1);
  });

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

  it("synced routine uses the local routine title while calendar cache refreshes", () => {
    const routines = [
      {
        id: "r1",
        title: "Updated routine",
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
        id: "master-1",
        title: "Old routine",
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
    expect(blocks[0].title).toBe("Updated routine");
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

  it("stale synced routine event is replaced by the edited local routine time", () => {
    const routines = [
      {
        id: "r1",
        title: "R edited",
        timeOfDay: "10:00",
        timeOverride: null,
        linkedEventId: null,
        linkedCalendarId: null,
        googleEventId: "master-1",
        googleCalendarId: "work-cal",
        durationMin: 45,
        done: false,
      },
    ] as never[];
    const events = [
      {
        id: "master-1_20260528T000000Z",
        recurringEventId: "master-1",
        title: "R old",
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
    expect(blocks[0].kind).toBe("routine");
    expect(blocks[0].title).toBe("R edited");
    expect(blocks[0].startISO).toContain("10:00");
    expect(blocks[0].endISO).toContain("10:45");
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

describe("blockNoteTarget", () => {
  it("maps a signal block to its bare id", () => {
    expect(blockNoteTarget({ kind: "signal", id: "signal:s1", calendarId: "" })).toEqual({
      targetKind: "signal",
      targetId: "s1",
    });
  });

  it("maps a routine block to its routineId", () => {
    expect(
      blockNoteTarget({ kind: "routine", id: "routine:r1", routineId: "r1", calendarId: "" }),
    ).toEqual({ targetKind: "routine", targetId: "r1" });
  });

  it("returns null for a routine block missing routineId", () => {
    expect(blockNoteTarget({ kind: "routine", id: "routine:r1", calendarId: "" })).toBeNull();
  });

  it("maps an event block to calendarId:linkedEventId", () => {
    expect(
      blockNoteTarget({
        kind: "event",
        id: "event:cal-1:evt-9",
        calendarId: "cal-1",
        linkedEventId: "evt-9",
      }),
    ).toEqual({ targetKind: "event", targetId: "cal-1:evt-9" });
  });

  it("returns null for an event block without a linked event", () => {
    expect(
      blockNoteTarget({ kind: "event", id: "event:cal-1:evt-9", calendarId: "cal-1" }),
    ).toBeNull();
  });

  it("produces a stable map key that round-trips a stored note target", () => {
    // 표시(blockNoteTarget) ↔ 저장(note.targetKind/targetId) 키가 일치해야 메모가 블록에 붙는다.
    const target = blockNoteTarget({
      kind: "event",
      id: "event:cal-1:evt-9",
      calendarId: "cal-1",
      linkedEventId: "evt-9",
    });
    expect(target).not.toBeNull();
    const fromBlock = noteTargetMapKey(target!.targetKind, target!.targetId);
    const fromNote = noteTargetMapKey("event", "cal-1:evt-9");
    expect(fromBlock).toBe(fromNote);
    // 다른 타깃끼리는 충돌하지 않는다.
    expect(noteTargetMapKey("signal", "a")).not.toBe(noteTargetMapKey("routine", "a"));
  });
});
