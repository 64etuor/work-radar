import { describe, expect, it } from "vitest";

import type { ControlRoomSnapshot } from "../bindings";
import { deriveEdgeState, laneHeaderPosition, toFlowEdges, toFlowNodes } from "./controlRoomFlow";
import { buildSchematic } from "./controlRoomGraph";

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

describe("toFlowNodes", () => {
  it("emits one lane header per lane plus one cr node per graph node", () => {
    const g = buildSchematic(
      snap({
        tasks: [{ taskId: "t1", title: "T1", phase: "active" }],
        sessions: [
          {
            sessionId: "s1",
            surface: "cmux:7",
            ownership: "user_owned" as const,
            taskId: "t1",
            phase: "active",
          },
        ],
      }),
    );
    const flow = toFlowNodes(g);
    const lanes = flow.filter((n) => n.type === "lane");
    const cr = flow.filter((n) => n.type === "cr");
    expect(lanes).toHaveLength(5);
    expect(cr).toHaveLength(g.nodes.length);
  });

  it("positions cr nodes at the builder's x/y (no auto-layout)", () => {
    const g = buildSchematic(snap({ tasks: [{ taskId: "t1", title: "T1", phase: "active" }] }));
    const taskNode = g.nodes.find((n) => n.lane === "task");
    const flowNode = toFlowNodes(g).find((n) => n.id === taskNode?.id);
    expect(flowNode?.position).toEqual({ x: taskNode?.x, y: taskNode?.y });
  });

  it("pins lane headers to the top band, one column apart", () => {
    expect(laneHeaderPosition(0).y).toBe(laneHeaderPosition(3).y);
    expect(laneHeaderPosition(1).x).toBeGreaterThan(laneHeaderPosition(0).x);
  });

  it("makes lane headers non-interactive", () => {
    const g = buildSchematic(snap({}));
    const lane = toFlowNodes(g).find((n) => n.type === "lane");
    expect(lane?.selectable).toBe(false);
    expect(lane?.draggable).toBe(false);
  });
});

describe("toFlowEdges", () => {
  const edges = [
    { id: "task:t1->session:s1", source: "task:t1", target: "session:s1" },
    { id: "session:s1->handoff:h1", source: "session:s1", target: "handoff:h1" },
  ];

  it("carries source/target and the cr edge type", () => {
    const flow = toFlowEdges(edges);
    expect(flow).toHaveLength(2);
    expect(flow[0]).toMatchObject({
      id: edges[0].id,
      source: "task:t1",
      target: "session:s1",
      type: "cr",
    });
  });

  it("flags active edges and dimmed edges via data", () => {
    const flow = toFlowEdges(edges, {
      activeIds: new Set(["task:t1->session:s1"]),
      dimIds: new Set(["session:s1->handoff:h1"]),
    });
    expect(flow[0].data).toEqual({ active: true, dim: false });
    expect(flow[1].data).toEqual({ active: false, dim: true });
  });

  it("defaults to no active / no dim when no sets passed", () => {
    const flow = toFlowEdges(edges);
    expect(flow[0].data).toEqual({ active: false, dim: false });
  });
});

describe("deriveEdgeState", () => {
  const node = (id: string, tone: string) =>
    ({
      id,
      lane: "task",
      rawId: id,
      label: id,
      tone,
      phase: "p",
      attention: false,
      ownership: null,
      x: 0,
      y: 0,
    }) as never;
  const edges = [
    { id: "a->b", source: "a", target: "b" },
    { id: "b->c", source: "b", target: "c" },
  ];
  const byId = (tones: Record<string, string>) =>
    new Map(Object.entries(tones).map(([id, tone]) => [id, node(id, tone)]));

  it("no lineage: edges touching an in-flight node are active, none dim", () => {
    const r = deriveEdgeState(edges, byId({ a: "active", b: "waiting", c: "done" }), null);
    expect([...r.activeIds]).toEqual(["a->b"]);
    expect(r.dimIds.size).toBe(0);
  });

  it("lineage focus: in-lineage edges active, others dim — in-flight rule suspended", () => {
    const r = deriveEdgeState(
      edges,
      byId({ a: "active", b: "waiting", c: "done" }),
      new Set(["b->c"]),
    );
    expect([...r.activeIds]).toEqual(["b->c"]);
    expect([...r.dimIds]).toEqual(["a->b"]);
  });

  it("quiet graph: nothing active, nothing dim", () => {
    const r = deriveEdgeState(edges, byId({ a: "waiting", b: "waiting", c: "done" }), null);
    expect(r.activeIds.size).toBe(0);
    expect(r.dimIds.size).toBe(0);
  });
});
