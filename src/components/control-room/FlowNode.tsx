import { Handle, type NodeProps, Position } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";

import type { CrFlowNode, FlowNodeData, LaneNodeData } from "../../lib/controlRoomFlow";
import { NODE_H, NODE_W } from "../../lib/controlRoomGraph";

export type NodeRenderState = "normal" | "highlight" | "dim";

const LANE_LABEL: Record<string, string> = {
  spec: "SPEC",
  plan: "PLAN",
  task: "TASK",
  session: "SESSION",
  handoff: "HANDOFF",
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Lane header — a non-interactive label pinned to the top of its column. */
export function FlowLaneNode({ data }: NodeProps<CrFlowNode & { type: "lane" }>) {
  const { lane } = data as LaneNodeData;
  return <div className="cr-flow-lane">{LANE_LABEL[lane] ?? lane.toUpperCase()}</div>;
}

/**
 * Work node — a rounded rect card matching the SVG schematic's tone palette.
 * Tone drives the left accent + border via --cr-* vars (CSS). Attention ring +
 * in-flight pulse are CSS animations (prefers-reduced-motion gated in the CSS).
 *
 * Render state (highlight/dim) is threaded through `data.renderState`, which the
 * canvas recomputes from hover/selection/vitals so dimming survives RF's memo.
 */
export function FlowWorkNode({ data, selected }: NodeProps<CrFlowNode & { type: "cr" }>) {
  const { node, renderState } = data as FlowNodeData & { renderState?: NodeRenderState };
  const state: NodeRenderState = renderState ?? "normal";
  return (
    <div
      className="cr-flow-node"
      data-tone={node.tone}
      data-state={state}
      data-inflight={node.tone === "active" || undefined}
      data-attention={node.attention || undefined}
      data-selected={selected || undefined}
      style={{ width: NODE_W, height: NODE_H }}
      aria-label={`${node.lane} ${node.label} — ${node.phase}`}
    >
      {/* Handles are required for edges to connect; hidden + non-connectable. */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="cr-flow-handle"
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="cr-flow-handle"
      />
      {node.attention && <AlertTriangle className="cr-flow-node-flag" size={12} aria-hidden />}
      <div className="cr-flow-node-label">{truncate(node.label, 18)}</div>
      <div className="cr-flow-node-phase">{node.phase}</div>
    </div>
  );
}
