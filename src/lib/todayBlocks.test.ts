import { describe, expect, it } from "vitest";

import {
  blockNoteTarget,
  buildTimelineBlocks,
  buildTodayBlocks,
  eventBlockApiId,
  noteTargetMapKey,
} from "./todayBlocks";

const DATE = "2026-05-28";

describe("buildTodayBlocks", () => {
  it("excludes placements whose date differs from the selected date", () => {
    // rollover 레일에는 다른 날짜로 배치된 signal이 남을 수 있다 — 보는 날짜와 다르면 제외돼야 한다.
    const signals = [
      { id: "today", title: "오늘 배치", scheduledAt: null, scheduledDuration: null },
      { id: "other", title: "다른날 배치", scheduledAt: null, scheduledDuration: null },
    ] as never[];
    const placements = [
      { id: "p1", signalId: "today", date: DATE, startAt: `${DATE}T09:00:00`, durationMin: 60 },
      {
        id: "p2",
        signalId: "other",
        date: "2026-05-29",
        startAt: "2026-05-29T09:00:00",
        durationMin: 60,
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, placements, events: [], routines: [], date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe(`signal:today:${DATE}`);
    expect(blocks[0].signalId).toBe("today");
  });

  it("keeps a placement with a local offset startAt on the same local date", () => {
    const signals = [
      { id: "s1", title: "오프셋", scheduledAt: null, scheduledDuration: null },
    ] as never[];
    const placements = [
      {
        id: "p1",
        signalId: "s1",
        date: DATE,
        startAt: `${DATE}T23:30:00+09:00`,
        durationMin: 30,
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, placements, events: [], routines: [], date: DATE });
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
    const placements = [
      {
        id: "p1",
        signalId: "s1",
        date: DATE,
        startAt: "2026-05-28T09:00:00",
        durationMin: 60,
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
    const blocks = buildTodayBlocks({ signals, placements, events, routines: [], date: DATE });
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
    const placements = [
      {
        id: "p1",
        signalId: "s1",
        date: DATE,
        startAt: "2026-05-28T09:00:00",
        durationMin: 60,
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
    const blocks = buildTodayBlocks({ signals, placements, events, routines: [], date: DATE });
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
    const blocks = buildTodayBlocks({
      signals: [],
      placements: [],
      events,
      routines: [],
      date: DATE,
    });
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
    const blocks = buildTodayBlocks({
      signals: [],
      placements: [],
      events,
      routines: [],
      date: DATE,
    });
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
    const blocks = buildTodayBlocks({
      signals: [],
      placements: [],
      events,
      routines: [],
      date: DATE,
    });
    expect(blocks).toHaveLength(0);
  });

  it("routine with timeOfDay produces virtual instance", () => {
    const routines = [{ id: "r1", title: "R", timeOfDay: "07:00", timeOverride: null }] as never[];
    const blocks = buildTodayBlocks({
      signals: [],
      placements: [],
      events: [],
      routines,
      date: DATE,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("routine");
    expect(blocks[0].startISO).toContain("07:00");
  });

  it("routine timeOverride wins over timeOfDay", () => {
    const routines = [
      { id: "r1", title: "R", timeOfDay: "07:00", timeOverride: "09:00" },
    ] as never[];
    const blocks = buildTodayBlocks({
      signals: [],
      placements: [],
      events: [],
      routines,
      date: DATE,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startISO).toContain("09:00");
  });

  it("routine without any time is skipped", () => {
    const routines = [{ id: "r1", title: "R", timeOfDay: null, timeOverride: null }] as never[];
    const blocks = buildTodayBlocks({
      signals: [],
      placements: [],
      events: [],
      routines,
      date: DATE,
    });
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
    const blocks = buildTodayBlocks({ signals: [], placements: [], events, routines, date: DATE });
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
    const blocks = buildTodayBlocks({ signals: [], placements: [], events, routines, date: DATE });
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
    const blocks = buildTodayBlocks({ signals: [], placements: [], events, routines, date: DATE });
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
    const blocks = buildTodayBlocks({ signals: [], placements: [], events, routines, date: DATE });
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
    const blocks = buildTodayBlocks({ signals: [], placements: [], events, routines, date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("routine");
    expect(blocks[0].title).toBe("R edited");
    expect(blocks[0].startISO).toContain("10:00");
    expect(blocks[0].endISO).toContain("10:45");
  });

  // 회귀: 동기화 루틴 블록 드래그 — 이벤트 patch + routine_checks.time_override 미러가 한 쌍.
  // timeOverride가 이벤트의 새 시각과 일치하면 블록은 (옛 시각 가상 블록이 아니라)
  // 이동된 이벤트로 렌더돼야 한다. 이전엔 이벤트만 움직여 stale 판정 → 원위치 스냅백.
  it("moved synced routine renders the event at its new time when timeOverride follows", () => {
    const routines = [
      {
        id: "r1",
        title: "R",
        timeOfDay: "09:00",
        timeOverride: "10:30",
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
        start: "2026-05-28T10:30:00",
        end: "2026-05-28T11:00:00",
        allDay: false,
        calendarId: "work-cal",
        calendarSummary: "업무",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], placements: [], events, routines, date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("event");
    expect(blocks[0].routineId).toBe("r1");
    expect(blocks[0].startISO).toContain("10:30");
  });

  // 회귀: 동기화 루틴 블록 리사이즈 — per-day duration은 routine_checks에 표현 불가라
  // duration까지 비교하면 영구 불일치(블록이 정의 길이로 스냅백 + 실제 이벤트 숨김).
  // 시각이 일치하면 길이는 이벤트가 정본 — 리사이즈된 길이 그대로 렌더.
  it("resized synced routine event keeps the event duration (time-only stale match)", () => {
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
        durationMin: 30,
        done: false,
      },
    ] as never[];
    const events = [
      {
        id: "master-1_20260528T000000Z",
        recurringEventId: "master-1",
        title: "R",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarId: "work-cal",
        calendarSummary: "업무",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals: [], placements: [], events, routines, date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("event");
    expect(blocks[0].endISO).toContain("10:00");
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
    const blocks = buildTodayBlocks({
      signals: [],
      placements: [],
      events: [],
      routines,
      date: DATE,
    });
    expect(blocks).toHaveLength(0);
  });

  it("plusMin preserves local time across hour boundary (no UTC drift)", () => {
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
    const placements = [
      {
        id: "p1",
        signalId: "s1",
        date: DATE,
        startAt: "2026-05-28T23:30:00",
        durationMin: 60,
      },
    ] as never[];
    const blocks = buildTodayBlocks({ signals, placements, events: [], routines: [], date: DATE });
    // local 00:30 다음날, NOT 15:30Z(UTC). `.toISOString()` 회귀 차단.
    expect(blocks[0].endISO).toMatch(/^2026-05-29T00:30:00/);
    // 로컬 포맷 보존 확인 — 'Z' 접미사 금지.
    expect(blocks[0].endISO.endsWith("Z")).toBe(false);
  });

  it("signal without a placement is skipped (unscheduled)", () => {
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
    const blocks = buildTodayBlocks({
      signals,
      placements: [],
      events: [],
      routines: [],
      date: DATE,
    });
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

describe("buildTimelineBlocks (멀티데이 병합)", () => {
  const event = (id: string, start: string, end: string) =>
    ({
      id,
      calendarId: "cal1",
      calendarSummary: "Cal 1",
      title: id,
      start,
      end,
      allDay: false,
      projectColor: null,
    }) as never;

  it("자정 걸침 이벤트가 인접 두 날짜 버킷에 중복으로 와도 1개 블록", () => {
    const e = event("ev1", "2026-06-11T23:00:00+09:00", "2026-06-12T01:30:00+09:00");
    const out = buildTimelineBlocks({
      signals: [],
      placements: [],
      eventsByDate: { "2026-06-11": [e], "2026-06-12": [e] },
      routinesByDate: {},
      dates: ["2026-06-11", "2026-06-12"],
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("event:cal1:ev1");
    expect(out[0].endISO).toBe("2026-06-12T01:30:00+09:00"); // full span 유지
  });

  it("같은 루틴의 가상 인스턴스는 날짜별로 별개 블록(id에 날짜 포함)", () => {
    const routine = {
      id: "r1",
      title: "운동",
      timeOfDay: "07:00",
      timeOverride: null,
    } as never;
    const out = buildTimelineBlocks({
      signals: [],
      placements: [],
      eventsByDate: {},
      routinesByDate: { "2026-06-11": [routine], "2026-06-12": [routine] },
      dates: ["2026-06-11", "2026-06-12"],
    });
    const ids = out.map((b) => b.id).sort();
    expect(ids).toEqual(["routine:r1:2026-06-11", "routine:r1:2026-06-12"]);
    expect(out.every((b) => b.routineId === "r1")).toBe(true);
  });

  it("signal은 placement 날짜에서만 렌더 (scheduledAt 무관)", () => {
    // 기존 scheduledAt 기반 테스트 → placement 기반으로 전환.
    // placement가 2026-06-12에 있으면 해당 날짜에만 1블록.
    const signal = {
      id: "s1",
      title: "작업",
      scheduledAt: null,
      scheduledDuration: null,
    } as never;
    const placement = {
      id: "p1",
      signalId: "s1",
      date: "2026-06-12",
      startAt: "2026-06-12T02:00:00",
      durationMin: 60,
    } as never;
    const out = buildTimelineBlocks({
      signals: [signal],
      placements: [placement],
      eventsByDate: {},
      routinesByDate: {},
      dates: ["2026-06-11", "2026-06-12"],
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("signal:s1:2026-06-12");
    expect(out[0].startISO).toBe("2026-06-12T02:00:00");
  });
});

describe("buildTodayBlocks — placement 기반 signal 렌더링", () => {
  it("renders a block from the viewed date's placement (not scheduledAt)", () => {
    // signal에 scheduledAt 없어도 placement(2026-06-11 14:00, 60분)로 블록 생성
    const signals = [
      { id: "s1", title: "플레이스먼트 시그널", scheduledAt: null, scheduledDuration: null },
    ] as never[];
    const placements = [
      {
        id: "p1",
        signalId: "s1",
        date: "2026-06-11",
        startAt: "2026-06-11T14:00:00",
        durationMin: 60,
      },
    ] as never[];
    const blocks = buildTodayBlocks({
      signals,
      placements,
      events: [],
      routines: [],
      date: "2026-06-11",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("signal:s1:2026-06-11");
    expect(blocks[0].signalId).toBe("s1");
    expect(blocks[0].startISO).toBe("2026-06-11T14:00:00");
    expect(blocks[0].kind).toBe("signal");
  });

  it("multi-day: same signal renders one block per placed date, no dedup collision", () => {
    // placements 6/10+6/11, buildTimelineBlocks dates 2일 → signal 블록 2개
    const signals = [
      { id: "s1", title: "반복 시그널", scheduledAt: null, scheduledDuration: null },
    ] as never[];
    const placements = [
      {
        id: "p1",
        signalId: "s1",
        date: "2026-06-10",
        startAt: "2026-06-10T10:00:00",
        durationMin: 30,
      },
      {
        id: "p2",
        signalId: "s1",
        date: "2026-06-11",
        startAt: "2026-06-11T10:00:00",
        durationMin: 30,
      },
    ] as never[];
    const out = buildTimelineBlocks({
      signals,
      placements,
      eventsByDate: {},
      routinesByDate: {},
      dates: ["2026-06-10", "2026-06-11"],
    });
    const signalBlocks = out.filter((b) => b.kind === "signal");
    expect(signalBlocks).toHaveLength(2);
    const ids = signalBlocks.map((b) => b.id).sort();
    expect(ids).toEqual(["signal:s1:2026-06-10", "signal:s1:2026-06-11"]);
    // id 충돌 없이 각 블록이 별개 아이디 보유
    expect(new Set(ids).size).toBe(2);
  });

  it("no placement on viewed date -> no signal block (tray case)", () => {
    // placement 6/10만 있고 date=6/11 → 블록 0개
    const signals = [
      { id: "s1", title: "어제 시그널", scheduledAt: null, scheduledDuration: null },
    ] as never[];
    const placements = [
      {
        id: "p1",
        signalId: "s1",
        date: "2026-06-10",
        startAt: "2026-06-10T10:00:00",
        durationMin: 30,
      },
    ] as never[];
    const blocks = buildTodayBlocks({
      signals,
      placements,
      events: [],
      routines: [],
      date: "2026-06-11",
    });
    expect(blocks).toHaveLength(0);
  });

  it("placement signal absorbs linked google event on the same date", () => {
    // signal with linkedCalendarId/linkedEventId + scheduledAt on the viewed date
    // + matching Google event → event NOT rendered (absorbed), signal block rendered once
    const signals = [
      {
        id: "s1",
        title: "S",
        scheduledAt: "2026-06-11T09:00:00",
        scheduledDuration: 60,
        linkedEventId: "g1",
        linkedCalendarId: "cal-id",
      },
    ] as never[];
    const placements = [
      {
        id: "p1",
        signalId: "s1",
        date: "2026-06-11",
        startAt: "2026-06-11T09:00:00",
        durationMin: 60,
      },
    ] as never[];
    const events = [
      {
        id: "g1",
        title: "G",
        start: "2026-06-11T09:00:00",
        end: "2026-06-11T10:00:00",
        allDay: false,
        calendarId: "cal-id",
        calendarSummary: "cal",
        projectColor: "#444",
      },
    ] as never[];
    const blocks = buildTodayBlocks({
      signals,
      placements,
      events,
      routines: [],
      date: "2026-06-11",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("signal");
    expect(blocks[0].id).toBe("signal:s1:2026-06-11");
  });
});

describe("buildTimelineBlocks — off-date 미러 absorb 회귀", () => {
  it("stale mirror event on an earlier placed date is absorbed (no double render)", () => {
    // 시그널이 6/10+6/11 두 placement 보유, 미러 이벤트는 6/10 버킷에 남은 stale 캐시
    // (scheduledAt=최신 배치 6/11). placement가 있는 날짜에선 placement 블록이 SSOT —
    // 6/10 이벤트는 absorbed, signal 블록은 날짜별 1개씩 총 2개.
    const signals = [
      {
        id: "s1",
        title: "S",
        scheduledAt: "2026-06-11T10:00:00",
        scheduledDuration: 30,
        linkedEventId: "g1",
        linkedCalendarId: "cal-id",
      },
    ] as never[];
    const placements = [
      {
        id: "p1",
        signalId: "s1",
        date: "2026-06-10",
        startAt: "2026-06-10T10:00:00",
        durationMin: 30,
      },
      {
        id: "p2",
        signalId: "s1",
        date: "2026-06-11",
        startAt: "2026-06-11T10:00:00",
        durationMin: 30,
      },
    ] as never[];
    const staleMirror = {
      id: "g1",
      title: "S (mirror)",
      start: "2026-06-10T10:00:00",
      end: "2026-06-10T10:30:00",
      allDay: false,
      calendarId: "cal-id",
      calendarSummary: "cal",
      projectColor: "#444",
    } as never;
    const out = buildTimelineBlocks({
      signals,
      placements,
      eventsByDate: { "2026-06-10": [staleMirror] },
      routinesByDate: {},
      dates: ["2026-06-10", "2026-06-11"],
    });
    expect(out.filter((b) => b.kind === "event")).toHaveLength(0);
    const signalIds = out
      .filter((b) => b.kind === "signal")
      .map((b) => b.id)
      .sort();
    expect(signalIds).toEqual(["signal:s1:2026-06-10", "signal:s1:2026-06-11"]);
  });
});
