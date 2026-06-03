import { describe, it, expect } from "vitest";
import { toEventRows, subjectOf } from "../../src/graph/project.js";
import type { GovEvent } from "../../src/event/event.js";

function evt(over: Partial<GovEvent["frontmatter"]>, body = "Title line"): GovEvent {
  return {
    frontmatter: { id: "x", type: "task_created", source: "hermes", actor: "u", tags: [], ...over },
    body,
  };
}

describe("subjectOf", () => {
  it("anchors a birth event to its own id", () => {
    expect(subjectOf(evt({ id: "evt_t1", type: "task_created" }))).toEqual({
      type: "task", id: "evt_t1", relations: [],
    });
  });
  it("anchors a lifecycle event to related_to[0] and drops it from relations", () => {
    expect(subjectOf(evt({ id: "evt_s1", type: "task_started", related_to: ["evt_t1", "evt_other"] }))).toEqual({
      type: "task", id: "evt_t1", relations: ["evt_other"],
    });
  });
  it("returns null subject for non-subject event types", () => {
    expect(subjectOf(evt({ id: "evt_c1", type: "commit_recorded" }))).toEqual({
      type: null, id: null, relations: [],
    });
  });
});

describe("toEventRows", () => {
  it("derives one row per event with content_hash, occurred_at, subject", () => {
    const rows = toEventRows([evt({ id: "evt_20260603_101500_ab12", type: "task_created" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe("evt_20260603_101500_ab12");
    expect(rows[0].subject_type).toBe("task");
    expect(rows[0].subject_id).toBe("evt_20260603_101500_ab12");
    expect(rows[0].occurred_at).toBe("2026-06-03T10:15:00Z");
    expect(rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("sets authority_decision_id from a related decision proposal", () => {
    const events: GovEvent[] = [
      evt({ id: "dec_1", type: "decision_proposed" }),
      evt({ id: "evt_t1", type: "task_created", related_to: ["dec_1"] }),
    ];
    const taskRow = toEventRows(events).find((r) => r.event_id === "evt_t1")!;
    expect(taskRow.authority_decision_id).toBe("dec_1");
  });
});
