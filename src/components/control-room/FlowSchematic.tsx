import "@xyflow/react/dist/style.css";

import {
  Controls,
  type NodeMouseHandler,
  Panel,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ControlRoomSnapshot } from "../../bindings";
import {
  type CrFlowNode,
  deriveEdgeState,
  toFlowEdges,
  toFlowNodes,
} from "../../lib/controlRoomFlow";
import {
  buildSchematic,
  type GraphNode,
  lineageOf,
  nodeMatchesVital,
  type VitalKey,
} from "../../lib/controlRoomGraph";
import { FlowEdge } from "./FlowEdge";
import { FlowLaneNode, FlowWorkNode, type NodeRenderState } from "./FlowNode";
import { NodeTooltip } from "./NodeTooltip";

const nodeTypes = { cr: FlowWorkNode, lane: FlowLaneNode };
const edgeTypes = { cr: FlowEdge };

// Read-only diagram: no dragging, no connecting, no delete.
const FIT_VIEW_OPTIONS = { padding: 0.18, maxZoom: 1 } as const;

function FlowSchematicInner({
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

  // Esc clears the pinned selection only (mirrors the SVG version: no-op when
  // nothing is pinned, so it never fights an overlay shown on top).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected((cur) => (cur === null ? cur : null));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nodeState = useCallback(
    (n: GraphNode): NodeRenderState => {
      if (lineage) return lineage.has(n.id) ? "highlight" : "dim";
      if (filter) return nodeMatchesVital(n, filter) ? "highlight" : "dim";
      return "normal";
    },
    [lineage, filter],
  );

  // Edge highlight/dim — pure derivation, unit-tested in controlRoomFlow.test.ts.
  const { activeIds: activeEdgeIds, dimIds: dimEdgeIds } = useMemo(
    () => deriveEdgeState(schematic.edges, nodeById, lineage),
    [schematic.edges, nodeById, lineage],
  );

  const nodes: CrFlowNode[] = useMemo(() => {
    return toFlowNodes(schematic).map((n) => {
      if (n.type !== "cr") return n;
      const graphNode = (n.data as { node: GraphNode }).node;
      return {
        ...n,
        selected: selected === n.id,
        data: { ...n.data, renderState: nodeState(graphNode) },
      };
    });
  }, [schematic, nodeState, selected]);

  const edges = useMemo(
    () => toFlowEdges(schematic.edges, { activeIds: activeEdgeIds, dimIds: dimEdgeIds }),
    [schematic.edges, activeEdgeIds, dimEdgeIds],
  );

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    if (node.type !== "cr") return;
    setSelected((cur) => (cur === node.id ? null : node.id));
  }, []);

  const onNodeMouseEnter: NodeMouseHandler = useCallback((_, node) => {
    setHovered(node.type === "cr" ? node.id : null);
  }, []);
  const onNodeMouseLeave: NodeMouseHandler = useCallback(() => setHovered(null), []);

  const selectedNode = selected ? (nodeById.get(selected) ?? null) : null;

  return (
    <div className="cr-flow-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.4}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        proOptions={{ hideAttribution: false }}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={() => setSelected(null)}
      >
        <Controls showInteractive={false} className="cr-flow-controls" />
        {selectedNode && (
          <Panel position="top-right" className="cr-flow-panel">
            <NodeTooltipPanel node={selectedNode} />
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

/** NodeTooltip uses absolute x/y positioning for the SVG canvas; inside an RF
 *  Panel we want it docked, so wrap it to neutralize the absolute placement. */
function NodeTooltipPanel({ node }: { node: GraphNode }) {
  return (
    <div className="cr-flow-tooltip-dock">
      <NodeTooltip node={node} docked />
    </div>
  );
}

export function FlowSchematic({
  snap,
  filter,
}: {
  snap: ControlRoomSnapshot;
  filter: VitalKey | null;
}) {
  return (
    <ReactFlowProvider>
      <FlowSchematicInner snap={snap} filter={filter} />
    </ReactFlowProvider>
  );
}
