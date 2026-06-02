import { describe, it, expect } from "vitest";
import { derivePlanState, plansOf } from "../../src/plan/plan.js";
import type { GovEvent, EventType } from "../../src/event/event.js";

function evt(type: EventType, id: string, relatedTo?: string[], actor = "user", body = "Title line\n\nrest"): GovEvent {
  return { frontmatter: { id, type, source: "hermes", actor, tags: ["plan"], related_to: relatedTo }, body };
}
const proposed = evt("plan_proposed", "evt_p1", undefined, "planner", "Load feature X\n\n1. step a\n2. step b");

describe("derivePlanState", () => {
  it("a bare plan_proposed is draft", () => {
    expect(derivePlanState(proposed, []).phase).toBe("draft");
  });
  it("title is the first body line (the intent)", () => {
    expect(derivePlanState(proposed, []).title).toBe("Load feature X");
  });
  it("plan_accepted → active", () => {
    expect(derivePlanState(proposed, [evt("plan_accepted", "evt_a2", ["evt_p1"])]).phase).toBe("active");
  });
  it("latest of accepted/revised wins (revise after accept → needs_revision)", () => {
    const r = [evt("plan_accepted", "evt_a2", ["evt_p1"]), evt("plan_revised", "evt_a3", ["evt_p1"])];
    expect(derivePlanState(proposed, r).phase).toBe("needs_revision");
  });
  it("re-accept after revision → active", () => {
    const r = [
      evt("plan_accepted", "evt_a2", ["evt_p1"]),
      evt("plan_revised", "evt_a3", ["evt_p1"]),
      evt("plan_accepted", "evt_a4", ["evt_p1"]),
    ];
    expect(derivePlanState(proposed, r).phase).toBe("active");
  });
  it("plan_completed → completed (terminal, verdict set)", () => {
    const s = derivePlanState(proposed, [evt("plan_accepted", "evt_a2", ["evt_p1"]), evt("plan_completed", "evt_a5", ["evt_p1"])]);
    expect(s.phase).toBe("completed"); expect(s.verdict).toBe("completed");
  });
  it("plan_archived wins over completed (archive precedence)", () => {
    const s = derivePlanState(proposed, [evt("plan_completed", "evt_a5", ["evt_p1"]), evt("plan_archived", "evt_a6", ["evt_p1"])]);
    expect(s.phase).toBe("archived"); expect(s.verdict).toBe("archived");
  });
  it("plan_superseded wins over completed but not archived", () => {
    const sup = derivePlanState(proposed, [evt("plan_completed", "evt_a5", ["evt_p1"]), evt("plan_superseded", "evt_a7", ["evt_p1"])]);
    expect(sup.phase).toBe("superseded");
    const arc = derivePlanState(proposed, [evt("plan_superseded", "evt_a7", ["evt_p1"]), evt("plan_archived", "evt_a8", ["evt_p1"])]);
    expect(arc.phase).toBe("archived");
  });
  it("ignores unrelated event types (god-fold ban)", () => {
    const s = derivePlanState(proposed, [evt("task_started", "evt_x", ["evt_p1"]), evt("decision_approved", "evt_y", ["evt_p1"])]);
    expect(s.phase).toBe("draft");
  });
  it("plansOf filters plan_proposed only, chronological", () => {
    const all = [evt("plan_proposed", "evt_p2"), proposed, evt("plan_accepted", "evt_a2", ["evt_p1"])];
    expect(plansOf(all).map((e) => e.frontmatter.id)).toEqual(["evt_p1", "evt_p2"]);
  });
});
