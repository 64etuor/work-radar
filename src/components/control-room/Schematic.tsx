import { useEffect, useMemo, useState } from "react";

import type { ControlRoomSnapshot } from "../../bindings";
import {
  buildSchematic,
  type GraphNode,
  LANE_W,
  type LaneKind,
  lineageOf,
  nodeMatchesVital,
  PAD_X,
  PAD_Y,
  type VitalKey,
} from "../../lib/controlRoomGraph";
import { NodeTooltip } from "./NodeTooltip";
import { SchematicEdge } from "./SchematicEdge";
import { type NodeState, SchematicNode } from "./SchematicNode";

const LANE_LABEL: Record<LaneKind, string> = {
  spec: "SPEC",
  plan: "PLAN",
  task: "TASK",
  session: "SESSION",
  handoff: "HANDOFF",
};

export function Schematic({
  snap,
  filter,
}: {
  snap: ControlRoomSnapshot;
  filter: VitalKey | null;
}) {
  const schematic = useMemo(() => buildSchematic(snap), [snap]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const focusId = hovered ?? selected;
  const lineage = useMemo(
    () => (focusId ? lineageOf(focusId, schematic.edges) : null),
    [focusId, schematic.edges],
  );
  const nodeById = useMemo(() => new Map(schematic.nodes.map((n) => [n.id, n])), [schematic.nodes]);

  // Esc clears the pinned selection (local state only — not an overlay). No-op
  // when nothing is selected so it never interferes when shown behind an overlay.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected((cur) => (cur === null ? cur : null));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function nodeState(n: GraphNode): NodeState {
    if (lineage) return lineage.has(n.id) ? "highlight" : "dim";
    if (filter) return nodeMatchesVital(n, filter) ? "highlight" : "dim";
    return "normal";
  }

  function edgeState(edgeId: string): NodeState {
    if (lineage) return lineage.has(edgeId) ? "highlight" : "dim";
    return "normal";
  }

  const selectedNode = selected ? (nodeById.get(selected) ?? null) : null;

  return (
    <div className="cr-canvas-wrap">
      <svg
        className="cr-canvas"
        width={schematic.width}
        height={schematic.height}
        viewBox={`0 0 ${schematic.width} ${schematic.height}`}
        onClick={() => setSelected(null)}
      >
        <defs>
          <marker
            id="cr-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path className="cr-arrow-head" d="M0,0 L8,4 L0,8 Z" />
          </marker>
        </defs>

        {schematic.lanes.map((lane, i) => (
          <text key={lane} className="cr-lane-header" x={PAD_X + i * LANE_W} y={PAD_Y + 12}>
            {LANE_LABEL[lane]}
          </text>
        ))}

        {schematic.edges.map((e) => {
          const source = nodeById.get(e.source);
          const target = nodeById.get(e.target);
          if (!source || !target) return null;
          return (
            <SchematicEdge
              key={e.id}
              edge={e}
              source={source}
              target={target}
              state={edgeState(e.id)}
            />
          );
        })}

        {schematic.nodes.map((n, i) => (
          <SchematicNode
            key={n.id}
            node={n}
            index={i}
            state={nodeState(n)}
            selected={selected === n.id}
            onHover={setHovered}
            onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
          />
        ))}
      </svg>

      {selectedNode && <NodeTooltip node={selectedNode} />}
    </div>
  );
}
