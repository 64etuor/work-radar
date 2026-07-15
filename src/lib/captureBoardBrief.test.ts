import { describe, expect, it } from "vitest";

import type { RoutineToday, WorkSignal } from "@/bindings";

import { captureBoardBrief } from "./captureBoardBrief";

function signal(id: string, quadrant: WorkSignal["quadrant"]): WorkSignal {
  return { id, quadrant } as WorkSignal;
}

describe("captureBoardBrief", () => {
  it("reports the existing human-decision queues without inferring priority", () => {
    const signals = [
      signal("inbox-1", "unclassified"),
      signal("inbox-2", "unclassified"),
      signal("decision-1", "q1_do_now"),
      signal("decision-2", "q2_schedule"),
      signal("decision-3", "q4_drop"),
    ];
    const todayItems = [signal("today-1", "q1_do_now")];
    const routines = [{ id: "routine-1" }, { id: "routine-2" }] as RoutineToday[];

    expect(captureBoardBrief(signals, todayItems, routines)).toEqual({
      inbox: 2,
      decisions: 3,
      today: 1,
      routines: 2,
    });
  });
});
