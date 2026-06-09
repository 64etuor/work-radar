import { describe, expect, it } from "vitest";
import type { EventSource, EventType, GovEvent } from "../../src/event/event.js";
import { buildControlRoomSnapshot } from "../../src/snapshot/snapshot.js";

function evt(
  id: string,
  type: EventType,
  body: string,
  relatedTo?: string[],
  source: EventSource = "system",
): GovEvent {
  const frontmatter = {
    id,
    type,
    source,
    actor: "test",
    tags: [],
  };
  return {
    frontmatter: relatedTo ? { ...frontmatter, related_to: relatedTo } : frontmatter,
    body,
  };
}

function multiAxisEvents(): GovEvent[] {
  const taskId = "evt_20260608_090000_0001";
  const planId = "evt_20260608_090200_0003";
  const specId = "evt_20260608_090400_0005";
  const sessionId = "evt_20260608_090600_0007";
  const handoffId = "evt_20260608_090800_0009";

  return [
    evt(taskId, "task_created", "Fix live snapshot"),
    evt("evt_20260608_090100_0002", "task_started", "Started", [taskId]),
    evt(planId, "plan_proposed", "T4a live snapshot\n\n- fold events"),
    evt("evt_20260608_090300_0004", "plan_accepted", "Accepted", [planId]),
    evt(specId, "spec_proposed", "Control room snapshot\n\nSummary"),
    evt("evt_20260608_090500_0006", "spec_accepted", "Accepted", [specId]),
    evt(sessionId, "session_spawned", JSON.stringify({ surface: "pane:7" }), [taskId]),
    evt("evt_20260608_090700_0008", "session_observed", "", [sessionId]),
    evt(handoffId, "handoff_requested", "", [sessionId]),
    evt("evt_20260608_090900_0010", "handoff_drafted", "draft", [handoffId]),
    evt("evt_20260608_091000_0011", "handoff_validated", "valid", [handoffId]),
    evt("evt_20260608_091100_0012", "decision_blocked", "Needs human choice", [taskId]),
  ];
}

describe("buildControlRoomSnapshot", () => {
  it("folds a multi-axis event log into Control Room rows with newest generatedAt", () => {
    const snap = buildControlRoomSnapshot(multiAxisEvents());

    expect(snap.generatedAt).toBe("2026-06-08T09:11:00Z");
    expect(snap.tasks).toEqual([
      { taskId: "evt_20260608_090000_0001", title: "Fix live snapshot", phase: "active" },
    ]);
    expect(snap.plans).toEqual([
      { planId: "evt_20260608_090200_0003", title: "T4a live snapshot", phase: "active" },
    ]);
    expect(snap.specs).toEqual([
      { specId: "evt_20260608_090400_0005", title: "Control room snapshot", phase: "accepted" },
    ]);
    expect(snap.sessions).toEqual([
      {
        sessionId: "evt_20260608_090600_0007",
        surface: "pane:7",
        ownership: "orchestrator_owned",
        taskId: "evt_20260608_090000_0001",
        phase: "active",
      },
    ]);
    expect(snap.handoffs).toEqual([
      {
        handoffId: "evt_20260608_090800_0009",
        sessionId: "evt_20260608_090600_0007",
        phase: "pending",
      },
    ]);
    expect(snap.orchestrator).toEqual({
      tasks: [
        {
          taskId: "evt_20260608_090000_0001",
          phase: "active",
          hasOpenBlock: true,
        },
      ],
      plans: [{ planId: "evt_20260608_090200_0003", phase: "active" }],
      sessions: [
        {
          sessionId: "evt_20260608_090600_0007",
          phase: "active",
          ownership: "orchestrator_owned",
          taskId: "evt_20260608_090000_0001",
        },
      ],
    });
  });

  it("returns an empty valid snapshot for an empty event log", () => {
    expect(buildControlRoomSnapshot([])).toEqual({
      generatedAt: null,
      tasks: [],
      plans: [],
      specs: [],
      sessions: [],
      handoffs: [],
      orchestrator: { tasks: [], plans: [], sessions: [] },
    });
  });

  it("is deterministic for the same event log", () => {
    const events = multiAxisEvents();
    expect(buildControlRoomSnapshot(events)).toEqual(buildControlRoomSnapshot(events));
  });

  it("emits the expected camelCase JSON contract keys", () => {
    const json = JSON.parse(JSON.stringify(buildControlRoomSnapshot(multiAxisEvents())));
    expect(Object.keys(json).sort()).toEqual([
      "generatedAt",
      "handoffs",
      "orchestrator",
      "plans",
      "sessions",
      "specs",
      "tasks",
    ]);
    expect(Object.keys(json.tasks[0]).sort()).toEqual(["phase", "taskId", "title"]);
    expect(Object.keys(json.plans[0]).sort()).toEqual(["phase", "planId", "title"]);
    expect(Object.keys(json.specs[0]).sort()).toEqual(["phase", "specId", "title"]);
    expect(Object.keys(json.sessions[0]).sort()).toEqual([
      "ownership",
      "phase",
      "sessionId",
      "surface",
      "taskId",
    ]);
    expect(Object.keys(json.handoffs[0]).sort()).toEqual(["handoffId", "phase", "sessionId"]);
    expect(Object.keys(json.orchestrator.tasks[0]).sort()).toEqual([
      "hasOpenBlock",
      "phase",
      "taskId",
    ]);
    expect(Object.keys(json.orchestrator.plans[0]).sort()).toEqual(["phase", "planId"]);
    expect(Object.keys(json.orchestrator.sessions[0]).sort()).toEqual([
      "ownership",
      "phase",
      "sessionId",
      "taskId",
    ]);
  });
});
