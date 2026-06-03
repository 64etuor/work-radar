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

import { toNodeRows } from "../../src/graph/project.js";

describe("toNodeRows", () => {
  it("emits one node per subject across axes, reusing the folds", () => {
    const events: GovEvent[] = [
      evt({ id: "t1", type: "task_created" }, "Task one"),
      evt({ id: "ts1", type: "task_started", related_to: ["t1"] }),
      evt({ id: "p1", type: "plan_proposed" }, "Plan one"),
      evt({ id: "sp1", type: "spec_proposed" }, "Spec one"),
    ];
    const nodes = toNodeRows(events);
    const task = nodes.find((n) => n.node_id === "task:t1")!;
    expect(task.node_type).toBe("task");
    expect(task.title).toBe("Task one");
    expect(task.state_jsonb.phase).toBe("active");
    expect(nodes.map((n) => n.node_id).sort()).toEqual(["plan:p1", "spec:sp1", "task:t1"]);
  });
});

import { toEdgeRows } from "../../src/graph/project.js";

describe("toEdgeRows", () => {
  const events: GovEvent[] = [
    evt({ id: "t1", type: "task_created" }, "Task one"),
    evt({ id: "p1", type: "plan_proposed" }, "Plan one"),
    evt({ id: "p2", type: "plan_proposed" }, "Plan two"),
    evt({ id: "sup1", type: "plan_superseded", related_to: ["p1"], supersededBy: "p2" }),
    evt({ id: "sb1", type: "step_bound", related_to: ["p1", "t1"] }),
    // Real escalate.ts shape: decision_blocked related_to = [decisionId, taskId]; the decision
    // node is the proposal (dec1), so the blocks edge runs decision:dec1 → task:t1.
    evt({ id: "dec1", type: "decision_proposed" }, "Decision one"),
    evt({ id: "db1", type: "decision_blocked", related_to: ["dec1", "t1"] }, "Blocked fork"),
  ];
  const nodes = toNodeRows(events);
  const edges = toEdgeRows(events, nodes);
  const has = (type: string, from: string, to: string) =>
    edges.some((e) => e.edge_type === type && e.from_node_id === from && e.to_node_id === to);

  it("emits supersedes from the superseded plan to its replacement", () => {
    expect(has("supersedes", "plan:p1", "plan:p2")).toBe(true);
  });
  it("emits step_of from task to plan for a step_bound", () => {
    expect(has("step_of", "task:t1", "plan:p1")).toBe(true);
  });
  it("emits blocks from the decision proposal to the blocked task", () => {
    expect(has("blocks", "decision:dec1", "task:t1")).toBe(true);
  });
  it("produces deterministic edge ids (stable across reruns)", () => {
    expect(toEdgeRows(events, nodes).map((e) => e.edge_id)).toEqual(edges.map((e) => e.edge_id));
  });
});
