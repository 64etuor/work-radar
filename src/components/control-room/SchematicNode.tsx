import { AlertTriangle } from "lucide-react";

import { type GraphNode, NODE_H, NODE_W } from "../../lib/controlRoomGraph";

export type NodeState = "normal" | "highlight" | "dim";

interface Props {
  node: GraphNode;
  state: NodeState;
  selected: boolean;
  index: number;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function SchematicNode({ node, state, selected, index, onHover, onSelect }: Props) {
  return (
    <g
      className="cr-node"
      data-tone={node.tone}
      data-state={state}
      data-attention={node.attention || undefined}
      data-selected={selected || undefined}
      transform={`translate(${node.x}, ${node.y})`}
      style={{ animationDelay: `${Math.min(index * 18, 360)}ms` }}
      role="button"
      tabIndex={0}
      aria-label={`${node.lane} ${node.label} — ${node.phase}`}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <rect className="cr-node-box" width={NODE_W} height={NODE_H} rx={6} />
      {node.attention && (
        <AlertTriangle
          className="cr-node-flag"
          x={NODE_W - 20}
          y={7}
          width={12}
          height={12}
          aria-hidden
        />
      )}
      <text className="cr-node-label" x={11} y={20}>
        {truncate(node.label, 18)}
      </text>
      <text className="cr-node-phase" x={11} y={36}>
        {node.phase}
      </text>
    </g>
  );
}
