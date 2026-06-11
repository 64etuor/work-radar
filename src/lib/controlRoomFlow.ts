import type { Edge, Node } from "@xyflow/react";

import {
  type GraphEdge,
  type GraphNode,
  LANE_W,
  type LaneKind,
  PAD_X,
  PAD_Y,
  type Schematic,
} from "./controlRoomGraph";

/**
 * Pure adapter: maps the lane-positioned {@link Schematic} (from buildSchematic)
 * into React Flow nodes/edges. KEEPS the builder's geometry — RF nodes are
 * absolutely positioned, not auto-laid-out, so lanes stay as fixed columns.
 *
 * Two node types are emitted:
 *  - `lane`   — one per lane, a header label pinned to the top of its column.
 *  - `cr`     — one per GraphNode, carrying the full GraphNode in `data.node`.
 */

export interface FlowNodeData extends Record<string, unknown> {
  node: GraphNode;
}
export interface LaneNodeData extends Record<string, unknown> {
  lane: LaneKind;
}

export type CrFlowNode = Node<FlowNodeData, "cr"> | Node<LaneNodeData, "lane">;
export type CrFlowEdge = Edge;

/** Lane header position mirrors buildSchematic's lane column math. */
export function laneHeaderPosition(laneIdx: number): { x: number; y: number } {
  return { x: PAD_X + laneIdx * LANE_W, y: PAD_Y };
}

export function toFlowNodes(schematic: Schematic): CrFlowNode[] {
  const laneNodes: CrFlowNode[] = schematic.lanes.map((lane, idx) => ({
    id: `lane:${lane}`,
    type: "lane",
    position: laneHeaderPosition(idx),
    data: { lane },
    draggable: false,
    selectable: false,
    focusable: false,
  }));

  const workNodes: CrFlowNode[] = schematic.nodes.map((n) => ({
    id: n.id,
    type: "cr",
    position: { x: n.x, y: n.y },
    data: { node: n },
  }));

  return [...laneNodes, ...workNodes];
}

/**
 * Maps GraphEdges to RF edges. `active` flags edges that should animate (the
 * caller decides which — e.g. lineage edges or edges touching an in-flight
 * node). Animation itself is CSS-driven via the custom `cr` edge type so it can
 * respect prefers-reduced-motion.
 */
export function toFlowEdges(
  edges: GraphEdge[],
  opts: { activeIds?: Set<string>; dimIds?: Set<string> } = {},
): CrFlowEdge[] {
  const { activeIds, dimIds } = opts;
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "cr",
    data: {
      active: activeIds ? activeIds.has(e.id) : false,
      dim: dimIds ? dimIds.has(e.id) : false,
    },
  }));
}

/**
 * Pure edge-state derivation (extracted from FlowSchematic so it's unit-testable):
 * - active: edge is in the pinned/hover lineage, OR (when no lineage focus) either
 *   endpoint is an in-flight (active-tone) node so running work visibly animates.
 * - dim: a lineage focus exists and the edge is outside it.
 */
export function deriveEdgeState(
  edges: GraphEdge[],
  nodeById: ReadonlyMap<string, GraphNode>,
  lineage: ReadonlySet<string> | null,
): { activeIds: Set<string>; dimIds: Set<string> } {
  const activeIds = new Set<string>();
  const dimIds = new Set<string>();
  for (const e of edges) {
    const inLineage = lineage?.has(e.id) ?? false;
    const touchesInflight =
      nodeById.get(e.source)?.tone === "active" || nodeById.get(e.target)?.tone === "active";
    if (inLineage || (!lineage && touchesInflight)) activeIds.add(e.id);
    if (lineage && !inLineage) dimIds.add(e.id);
  }
  return { activeIds, dimIds };
}
