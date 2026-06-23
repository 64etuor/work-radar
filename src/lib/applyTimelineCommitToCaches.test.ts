import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import type { CalendarEvent, RoutineToday, SignalDayPlacement, WorkSignal } from "@/bindings";

import { applyTimelineCommitToCaches } from "./applyTimelineCommitToCaches";
import type { TimelineCommit } from "./timelineDragPlan";

const TODAY = "2026-05-28";

function signal(overrides: Partial<WorkSignal> = {}): WorkSignal {
  return {
    id: "sig-1",
    projectId: "proj-1",
    title: "Signal",
    body: null,
    source: "braindump",
    type: "task_candidate",
    quadrant: "q1_do_now",
    suggestedQuadrant: null,
    kind: null,
    area: null,
    areaTags: null,
    suggestedArea: null,
    status: "new",
    snoozeUntil: null,
    todayForDate: TODAY,
    todayDoneAt: null,
    todayRank: null,
    impactHigh: null,
    regret: null,
    scheduledAt: null,
    scheduledDuration: null,
    linkedEventId: null,
    linkedCalendarId: null,
    createdAt: "2026-05-28T00:00:00",
    updatedAt: "2026-05-28T00:00:00",
    ...overrides,
  };
}

function placement(overrides: Partial<SignalDayPlacement> = {}): SignalDayPlacement {
  return {
    id: "pl-1",
    signalId: "sig-1",
    date: TODAY,
    startAt: "2026-05-28T09:00:00",
    durationMin: 60,
    ...overrides,
  };
}

function calEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    recurringEventId: null,
    calendarId: "cal-1",
    calendarSummary: "Cal",
    title: "Event",
    start: "2026-05-28T09:00:00",
    end: "2026-05-28T10:00:00",
    allDay: false,
    location: null,
    url: null,
    projectId: "proj-1",
    projectColor: "#4a7bb8",
    projectTextColor: "#111827",
    ...overrides,
  };
}

function routine(overrides: Partial<RoutineToday> = {}): RoutineToday {
  return {
    id: "rt-1",
    title: "Routine",
    freq: "daily",
    weekdays: [],
    anchorDate: null,
    timeOfDay: "09:00",
    reminderOffsetMin: null,
    area: null,
    areaTags: null,
    kind: null,
    done: false,
    timeOverride: null,
    linkedEventId: null,
    linkedCalendarId: null,
    monthlyPattern: null,
    monthlyNthWeek: null,
    ...overrides,
  } as RoutineToday;
}

let qc: QueryClient;

beforeEach(() => {
  qc = new QueryClient();
});

function seedSignals(rows: WorkSignal[]) {
  qc.setQueryData<WorkSignal[]>(["signals"], rows);
  qc.setQueryData<WorkSignal[]>(
    ["today", TODAY],
    rows.map((r) => ({ ...r })),
  );
}

/**
 * 실제 placement 쿼리 키는 range 한 버킷(`["signalPlacements", start, end]`, query/today.ts:87) —
 * 로드된 날짜 전체가 한 배열에 들어간다. 그래서 move 패치는 한 버킷 안에서 fromDate 행 제거 + 새 날짜 행
 * 추가로 끝난다(per-date 버킷 아님). 본 헬퍼는 그 range 버킷을 시드해 production 정합을 정확히 재현한다.
 */
const PL_KEY = ["signalPlacements", TODAY, "2026-05-31"] as const;
function seedPlacements(rows: SignalDayPlacement[]) {
  qc.setQueryData<SignalDayPlacement[]>([...PL_KEY], rows);
}
function getPlacements() {
  return qc.getQueryData<SignalDayPlacement[]>([...PL_KEY])!;
}

describe("applyTimelineCommitToCaches — schedule", () => {
  it("patches signal caches (both keys) + upserts placement", () => {
    seedSignals([signal()]);
    seedPlacements([]);
    const commit: TimelineCommit = {
      kind: "schedule",
      targetSignalId: "sig-1",
      at: "2026-05-28T11:00:00",
      durationMin: 90,
      calendarId: "cal-9",
      title: "Signal",
    };
    applyTimelineCommitToCaches(qc, commit);

    for (const key of [["signals"], ["today", TODAY]]) {
      const rows = qc.getQueryData<WorkSignal[]>(key)!;
      expect(rows[0].scheduledAt).toBe("2026-05-28T11:00:00");
      expect(rows[0].scheduledDuration).toBe(90);
      expect(rows[0].linkedCalendarId).toBe("cal-9");
    }
    const pls = getPlacements();
    expect(pls).toHaveLength(1);
    expect(pls[0]).toMatchObject({
      signalId: "sig-1",
      date: TODAY,
      startAt: "2026-05-28T11:00:00",
      durationMin: 90,
    });
  });

  it("schedule without calendarId leaves linkedCalendarId untouched", () => {
    seedSignals([signal({ linkedCalendarId: "keep" })]);
    seedPlacements([]);
    applyTimelineCommitToCaches(qc, {
      kind: "schedule",
      targetSignalId: "sig-1",
      at: "2026-05-28T11:00:00",
      durationMin: 60,
    });
    expect(qc.getQueryData<WorkSignal[]>(["signals"])![0].linkedCalendarId).toBe("keep");
  });

  // PRECONDITION #1: planner는 schedule commit의 calendarId를 undefined로 남기고, onDragEnd가
  // picker로 해소한 cal을 `{ ...commit, calendarId: cal }`로 주입한다. 그 주입된 형태가 여전히
  // linkedCalendarId를 쓰는지(미주입 시 회귀=빈 calendarId 렌더) 명시 검증한다.
  it("schedule commit injected with a resolved calendarId writes linkedCalendarId", () => {
    seedSignals([signal({ linkedCalendarId: null })]);
    seedPlacements([]);
    // planner 산출과 동일한 형태: calendarId 없음.
    const plannerCommit: TimelineCommit = {
      kind: "schedule",
      targetSignalId: "sig-1",
      at: "2026-05-28T11:00:00",
      durationMin: 90,
      title: "Signal",
    };
    // onDragEnd의 주입 와이어링과 동치: 해소한 cal을 spread로 주입.
    applyTimelineCommitToCaches(qc, { ...plannerCommit, calendarId: "cal-resolved" });
    for (const key of [["signals"], ["today", TODAY]]) {
      expect(qc.getQueryData<WorkSignal[]>(key)![0].linkedCalendarId).toBe("cal-resolved");
    }
  });
});

describe("applyTimelineCommitToCaches — reschedule (signal)", () => {
  it("patches scheduledAt only (NOT duration) + moves placement", () => {
    seedSignals([signal({ scheduledAt: "2026-05-28T09:00:00", scheduledDuration: 60 })]);
    seedPlacements([placement()]);
    const commit: TimelineCommit = {
      kind: "reschedule",
      targetSignalId: "sig-1",
      at: "2026-05-29T08:00:00",
      durationMin: 999, // must NOT be written into scheduledDuration
      fromDate: TODAY,
    };
    applyTimelineCommitToCaches(qc, commit);

    const sig = qc.getQueryData<WorkSignal[]>(["signals"])![0];
    expect(sig.scheduledAt).toBe("2026-05-29T08:00:00");
    expect(sig.scheduledDuration).toBe(60); // unchanged

    // within the single range bucket: old fromDate row removed, new date row appended.
    const pls = getPlacements();
    expect(pls).toHaveLength(1);
    expect(pls[0]).toMatchObject({
      date: "2026-05-29",
      startAt: "2026-05-29T08:00:00",
      durationMin: 999, // placement DOES keep commit durationMin (unlike signal cache)
    });
  });
});

describe("applyTimelineCommitToCaches — resize (signal)", () => {
  it("patches scheduledAt + scheduledDuration + moves placement", () => {
    seedSignals([signal({ scheduledAt: "2026-05-28T09:00:00", scheduledDuration: 60 })]);
    seedPlacements([placement()]);
    const commit: TimelineCommit = {
      kind: "resize",
      targetSignalId: "sig-1",
      at: "2026-05-28T09:00:00",
      durationMin: 120,
      fromDate: TODAY,
    };
    applyTimelineCommitToCaches(qc, commit);

    const sig = qc.getQueryData<WorkSignal[]>(["signals"])![0];
    expect(sig.scheduledAt).toBe("2026-05-28T09:00:00");
    expect(sig.scheduledDuration).toBe(120);
    const pls = getPlacements();
    expect(pls).toHaveLength(1);
    expect(pls[0].durationMin).toBe(120);
  });
});

describe("applyTimelineCommitToCaches — unschedule", () => {
  it("clears signal link + removes placement + removes mirror event from ALL buckets", () => {
    seedSignals([
      signal({
        scheduledAt: "2026-05-28T09:00:00",
        scheduledDuration: 60,
        linkedEventId: "evt-1",
        linkedCalendarId: "cal-1",
      }),
    ]);
    seedPlacements([placement()]);
    // mirror event exists in TWO buckets (per-date + range) — both must be purged.
    qc.setQueryData<CalendarEvent[]>(
      ["calendarEvents", TODAY],
      [calEvent(), calEvent({ id: "other" })],
    );
    qc.setQueryData<CalendarEvent[]>(
      ["calendarEvents", "range", TODAY, "2026-05-30"],
      [calEvent()],
    );

    const commit: TimelineCommit = {
      kind: "unschedule",
      targetSignalId: "sig-1",
      fromDate: TODAY,
      calendarId: "cal-1",
      linkedEventId: "evt-1",
    };
    applyTimelineCommitToCaches(qc, commit);

    const sig = qc.getQueryData<WorkSignal[]>(["signals"])![0];
    expect(sig.scheduledAt).toBeNull();
    expect(sig.scheduledDuration).toBeNull();
    expect(sig.linkedEventId).toBeNull();
    expect(sig.linkedCalendarId).toBeNull();

    expect(getPlacements()).toEqual([]);

    // mirror gone from per-date bucket but unrelated event kept
    const perDate = qc.getQueryData<CalendarEvent[]>(["calendarEvents", TODAY])!;
    expect(perDate.map((e) => e.id)).toEqual(["other"]);
    // mirror gone from range bucket too
    expect(
      qc.getQueryData<CalendarEvent[]>(["calendarEvents", "range", TODAY, "2026-05-30"]),
    ).toEqual([]);
  });

  it("unschedule without linkedEventId leaves event caches untouched", () => {
    seedSignals([signal({ scheduledAt: "2026-05-28T09:00:00" })]);
    seedPlacements([placement()]);
    qc.setQueryData<CalendarEvent[]>(["calendarEvents", TODAY], [calEvent()]);
    applyTimelineCommitToCaches(qc, {
      kind: "unschedule",
      targetSignalId: "sig-1",
      fromDate: TODAY,
    });
    expect(qc.getQueryData<CalendarEvent[]>(["calendarEvents", TODAY])).toHaveLength(1);
  });
});

describe("applyTimelineCommitToCaches — eventResize", () => {
  it("patches event start+end via duration across all buckets", () => {
    qc.setQueryData<CalendarEvent[]>(["calendarEvents", TODAY], [calEvent()]);
    qc.setQueryData<CalendarEvent[]>(
      ["calendarEvents", "range", TODAY, "2026-05-30"],
      [calEvent()],
    );
    const commit: TimelineCommit = {
      kind: "eventResize",
      eventId: "evt-1",
      calendarId: "cal-1",
      at: "2026-05-28T09:30:00",
      durationMin: 45,
    };
    applyTimelineCommitToCaches(qc, commit);

    for (const key of [
      ["calendarEvents", TODAY],
      ["calendarEvents", "range", TODAY, "2026-05-30"],
    ]) {
      const e = qc.getQueryData<CalendarEvent[]>(key)![0];
      expect(e.start).toBe("2026-05-28T09:30:00");
      expect(e.end).toBe("2026-05-28T10:15:00"); // +45min
    }
  });

  it("eventResize on routine-backed event also patches routine timeOverride", () => {
    qc.setQueryData<CalendarEvent[]>(["calendarEvents", TODAY], [calEvent()]);
    qc.setQueryData<RoutineToday[]>(["routines", TODAY], [routine()]);
    applyTimelineCommitToCaches(qc, {
      kind: "eventResize",
      eventId: "evt-1",
      calendarId: "cal-1",
      at: "2026-05-28T07:15:00",
      durationMin: 30,
      routineId: "rt-1",
      routineDate: TODAY,
    });
    const rt = qc.getQueryData<RoutineToday[]>(["routines", TODAY])![0];
    expect(rt.timeOverride).toBe("07:15");
  });

  it("eventResize without routineId leaves routine cache untouched", () => {
    qc.setQueryData<CalendarEvent[]>(["calendarEvents", TODAY], [calEvent()]);
    qc.setQueryData<RoutineToday[]>(["routines", TODAY], [routine({ timeOverride: "keep" })]);
    applyTimelineCommitToCaches(qc, {
      kind: "eventResize",
      eventId: "evt-1",
      calendarId: "cal-1",
      at: "2026-05-28T07:15:00",
      durationMin: 30,
    });
    expect(qc.getQueryData<RoutineToday[]>(["routines", TODAY])![0].timeOverride).toBe("keep");
  });
});

describe("applyTimelineCommitToCaches — eventReschedule", () => {
  it("patches event + routine timeOverride when routine-backed", () => {
    qc.setQueryData<CalendarEvent[]>(["calendarEvents", TODAY], [calEvent()]);
    qc.setQueryData<RoutineToday[]>(["routines", TODAY], [routine()]);
    applyTimelineCommitToCaches(qc, {
      kind: "eventReschedule",
      eventId: "evt-1",
      calendarId: "cal-1",
      at: "2026-05-28T13:00:00",
      durationMin: 60,
      routineId: "rt-1",
      routineDate: TODAY,
    });
    const e = qc.getQueryData<CalendarEvent[]>(["calendarEvents", TODAY])![0];
    expect(e.start).toBe("2026-05-28T13:00:00");
    expect(e.end).toBe("2026-05-28T14:00:00");
    expect(qc.getQueryData<RoutineToday[]>(["routines", TODAY])![0].timeOverride).toBe("13:00");
  });
});

describe("applyTimelineCommitToCaches — routineReschedule", () => {
  it("patches routine timeOverride on the occurrence-date bucket only", () => {
    qc.setQueryData<RoutineToday[]>(["routines", TODAY], [routine()]);
    qc.setQueryData<RoutineToday[]>(
      ["routines", "2026-05-29"],
      [routine({ timeOverride: "keep" })],
    );
    applyTimelineCommitToCaches(qc, {
      kind: "routineReschedule",
      routineId: "rt-1",
      date: TODAY,
      at: "2026-05-28T15:30:00",
      durationMin: 30,
    });
    expect(qc.getQueryData<RoutineToday[]>(["routines", TODAY])![0].timeOverride).toBe("15:30");
    // other date bucket untouched
    expect(qc.getQueryData<RoutineToday[]>(["routines", "2026-05-29"])![0].timeOverride).toBe(
      "keep",
    );
  });
});

describe("applyTimelineCommitToCaches — routineResize", () => {
  it("patches timeOverride but NOT duration (no per-day duration column)", () => {
    qc.setQueryData<RoutineToday[]>(["routines", TODAY], [routine()]);
    applyTimelineCommitToCaches(qc, {
      kind: "routineResize",
      routineId: "rt-1",
      date: TODAY,
      at: "2026-05-28T06:45:00",
      durationMin: 120,
    });
    const rt = qc.getQueryData<RoutineToday[]>(["routines", TODAY])![0];
    expect(rt.timeOverride).toBe("06:45");
    // RoutineToday has no durationMin field persisted optimistically — assert no stray prop.
    expect((rt as Record<string, unknown>).durationMin).toBeUndefined();
  });
});

describe("applyTimelineCommitToCaches — routineSchedule", () => {
  it("does NOT optimistically patch any cache (invalidate-only branch)", () => {
    seedSignals([signal()]);
    qc.setQueryData<RoutineToday[]>(["routines", TODAY], [routine({ timeOverride: "keep" })]);
    qc.setQueryData<CalendarEvent[]>(["calendarEvents", TODAY], [calEvent()]);
    applyTimelineCommitToCaches(qc, {
      kind: "routineSchedule",
      routineId: "rt-1",
      date: TODAY,
      at: "2026-05-28T16:00:00",
      durationMin: 30,
      title: "Routine",
    });
    expect(qc.getQueryData<RoutineToday[]>(["routines", TODAY])![0].timeOverride).toBe("keep");
    expect(qc.getQueryData<CalendarEvent[]>(["calendarEvents", TODAY])).toHaveLength(1);
  });
});

describe("applyTimelineCommitToCaches — moveCalendar", () => {
  it("does NOT optimistically patch any cache (staged, INVARIANT #2)", () => {
    seedSignals([signal({ scheduledAt: "2026-05-28T09:00:00", linkedCalendarId: "cal-1" })]);
    qc.setQueryData<CalendarEvent[]>(["calendarEvents", TODAY], [calEvent()]);
    applyTimelineCommitToCaches(qc, {
      kind: "moveCalendar",
      targetSignalId: "sig-1",
      calendarId: "cal-2",
      at: "2026-05-28T10:00:00",
      durationMin: 60,
      title: "Signal",
    });
    const sig = qc.getQueryData<WorkSignal[]>(["signals"])![0];
    expect(sig.scheduledAt).toBe("2026-05-28T09:00:00"); // unchanged
    expect(sig.linkedCalendarId).toBe("cal-1"); // unchanged
    expect(qc.getQueryData<CalendarEvent[]>(["calendarEvents", TODAY])).toHaveLength(1);
  });
});
