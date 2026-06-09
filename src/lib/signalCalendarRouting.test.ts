import { describe, expect, it } from "vitest";

import type { Kind, Project } from "@/bindings";

import { signalCalendarProjectId } from "./signalCalendarRouting";

function project(over: Partial<Project>): Project {
  return {
    id: "p",
    name: "P",
    kind: "work",
    notionBacklogDbId: null,
    notionAgendaDbId: null,
    googleCalendarIds: null,
    calendarColor: null,
    defaultWriteCalendarId: null,
    credentialRef: "ref",
    createdAt: "2026-06-09T00:00:00",
    updatedAt: "2026-06-09T00:00:00",
    ...over,
  } as Project;
}

describe("signalCalendarProjectId", () => {
  const personal = project({ id: "personal-proj", kind: "personal" });
  const work = project({ id: "work-proj", kind: "work" });

  it("uses the existing project when it still matches the signal kind", () => {
    expect(signalCalendarProjectId([personal, work], "work-proj", "work")).toBe("work-proj");
  });

  it("reroutes stale work project ids for personal cards to a personal project", () => {
    expect(signalCalendarProjectId([work, personal], "work-proj", "personal")).toBe(
      "personal-proj",
    );
  });

  it("falls back by kind when the signal has no project id", () => {
    expect(signalCalendarProjectId([personal, work], null, "personal")).toBe("personal-proj");
  });

  it("returns null when kind is unknown or no matching project exists", () => {
    expect(signalCalendarProjectId([work], null, "personal")).toBeNull();
    expect(signalCalendarProjectId([personal, work], "work-proj", null as Kind | null)).toBeNull();
  });
});
