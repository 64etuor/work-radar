import { describe, expect, it } from "vitest";

import type { ControlRoomSnapshot, SessionPhase } from "../bindings";
import {
  buildSchematic,
  computeVitals,
  deriveEdges,
  type GraphNode,
  LANE_W,
  lineageOf,
  nodeMatchesVital,
  PAD_X,
} from "./controlRoomGraph";

function snap(partial: Partial<ControlRoomSnapshot>): ControlRoomSnapshot {
  return {
    generatedAt: null,
    tasks: [],
    plans: [],
    specs: [],
    sessions: [],
    handoffs: [],
    orchestrator: { tasks: [], plans: [], sessions: [] },
    ...partial,
  };
}

function sess(sessionId: string, phase: SessionPhase, taskId: string | null = null) {
  return { sessionId, surface: null, ownership: "user_owned" as const, taskId, phase };
}

function node(lane: GraphNode["lane"], phase: string, attention = false): GraphNode {
  return {
    id: `${lane}:x`,
    lane,
    rawId: "x",
    label: "x",
    tone: "muted",
    phase,
    attention,
    ownership: null,
    x: 0,
    y: 0,
  };
}

describe("deriveEdges", () => {
  it("links session→task and handoff→session left-to-right", () => {
    const s = snap({
      tasks: [{ taskId: "t1", title: "T1", phase: "active" }],
      sessions: [sess("s1", "active", "t1")],
      handoffs: [{ handoffId: "h1", sessionId: "s1", phase: "pending" }],
    });
    expect(deriveEdges(s)).toEqual([
      { id: "task:t1->session:s1", source: "task:t1", target: "session:s1" },
      { id: "session:s1->handoff:h1", source: "session:s1", target: "handoff:h1" },
    ]);
  });

  it("drops edges whose endpoint node is missing", () => {
    const s = snap({ sessions: [sess("s1", "active", "ghost")] });
    expect(deriveEdges(s)).toEqual([]);
  });
});

describe("computeVitals", () => {
  it("counts in-progress, blocked, and awaiting-human", () => {
    const s = snap({
      sessions: [
        sess("s1", "active"),
        sess("s2", "opening"),
        sess("s3", "blocked"),
        sess("s4", "handoff_ready"),
      ],
      handoffs: [{ handoffId: "h1", sessionId: "s1", phase: "pending" }],
      orchestrator: {
        tasks: [{ taskId: "t1", phase: "blocked", hasOpenBlock: true }],
        plans: [],
        sessions: [],
      },
    });
    expect(computeVitals(s)).toEqual({ inProgress: 2, blocked: 2, awaitingHuman: 2, sessions: 4 });
  });
});

describe("nodeMatchesVital", () => {
  it("maps node lane/phase/attention to vital buckets", () => {
    expect(nodeMatchesVital(node("session", "active"), "inProgress")).toBe(true);
    expect(nodeMatchesVital(node("task", "blocked", true), "blocked")).toBe(true);
    expect(nodeMatchesVital(node("session", "blocked"), "blocked")).toBe(true);
    expect(nodeMatchesVital(node("handoff", "pending"), "awaitingHuman")).toBe(true);
    expect(nodeMatchesVital(node("session", "checkpoint_requested"), "awaitingHuman")).toBe(true);
    expect(nodeMatchesVital(node("spec", "draft"), "inProgress")).toBe(false);
  });
});

describe("buildSchematic", () => {
  it("columns lanes and floats attention nodes to the top of a lane", () => {
    const s = snap({
      tasks: [
        { taskId: "t1", title: "calm", phase: "active" },
        { taskId: "t2", title: "stuck", phase: "blocked" },
      ],
      orchestrator: {
        tasks: [{ taskId: "t2", phase: "blocked", hasOpenBlock: true }],
        plans: [],
        sessions: [],
      },
    });
    const g = buildSchematic(s);
    const tasks = g.nodes.filter((n) => n.lane === "task");
    expect(tasks.map((n) => n.rawId)).toEqual(["t2", "t1"]); // attention first
    expect(tasks[0].attention).toBe(true);
    expect(tasks[0].x).toBe(PAD_X + 2 * LANE_W); // task is lane index 2
    expect(tasks[0].y).toBeLessThan(tasks[1].y);
  });

  it("labels sessions by surface and carries ownership", () => {
    const g = buildSchematic(
      snap({
        sessions: [
          {
            sessionId: "s1",
            surface: "cmux:7",
            ownership: "orchestrator_owned",
            taskId: null,
            phase: "active",
          },
        ],
      }),
    );
    const n = g.nodes.find((x) => x.lane === "session");
    expect(n?.label).toBe("cmux:7");
    expect(n?.ownership).toBe("orchestrator_owned");
  });
});

describe("lineageOf", () => {
  const edges = [
    { id: "task:t1->session:s1", source: "task:t1", target: "session:s1" },
    { id: "session:s1->handoff:h1", source: "session:s1", target: "handoff:h1" },
    { id: "task:t9->session:s9", source: "task:t9", target: "session:s9" },
  ];

  it("walks both directions and includes connecting edge ids", () => {
    const lin = lineageOf("session:s1", edges);
    expect(lin.has("task:t1")).toBe(true);
    expect(lin.has("handoff:h1")).toBe(true);
    expect(lin.has("task:t1->session:s1")).toBe(true);
    expect(lin.has("session:s1->handoff:h1")).toBe(true);
  });

  it("excludes disconnected components", () => {
    const lin = lineageOf("session:s1", edges);
    expect(lin.has("task:t9")).toBe(false);
    expect(lin.has("task:t9->session:s9")).toBe(false);
  });
});
