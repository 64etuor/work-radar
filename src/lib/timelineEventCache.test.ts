import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "@/bindings";

import { removeEventFromBuckets } from "./timelineEventCache";

function makeEvent(id: string, calendarId: string): CalendarEvent {
  return {
    id,
    calendarId,
    recurringEventId: null,
    calendarSummary: "Cal",
    title: "Event",
    start: "2026-06-23T09:00:00+09:00",
    end: "2026-06-23T10:00:00+09:00",
    allDay: false,
    location: null,
    url: null,
    projectId: "proj1",
    projectColor: "#ffffff",
    projectTextColor: "#111827",
  };
}

describe("removeEventFromBuckets", () => {
  it("removes the matching (calendarId, id) event", () => {
    const events = [makeEvent("e1", "calA"), makeEvent("e2", "calA"), makeEvent("e3", "calB")];
    const result = removeEventFromBuckets(events, "calA", "e1");
    expect(result).toHaveLength(2);
    expect(result.find((e) => e.id === "e1" && e.calendarId === "calA")).toBeUndefined();
  });

  it("preserves events with the same id but a different calendarId", () => {
    const events = [makeEvent("e1", "calA"), makeEvent("e1", "calB")];
    const result = removeEventFromBuckets(events, "calA", "e1");
    expect(result).toHaveLength(1);
    expect(result[0].calendarId).toBe("calB");
  });

  it("preserves events with a different id on the same calendar", () => {
    const events = [makeEvent("e1", "calA"), makeEvent("e2", "calA")];
    const result = removeEventFromBuckets(events, "calA", "e1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("e2");
  });

  it("returns the same array when no event matches", () => {
    const events = [makeEvent("e1", "calA"), makeEvent("e2", "calB")];
    const result = removeEventFromBuckets(events, "calC", "e99");
    expect(result).toHaveLength(2);
  });

  it("handles an empty array", () => {
    expect(removeEventFromBuckets([], "calA", "e1")).toEqual([]);
  });
});
