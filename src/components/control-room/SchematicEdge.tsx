import { motion, useReducedMotion } from "motion/react";

import { type GraphEdge, type GraphNode, NODE_H, NODE_W } from "../../lib/controlRoomGraph";
import type { NodeState } from "./SchematicNode";

interface Props {
  edge: GraphEdge;
  source: GraphNode;
  target: GraphNode;
  state: NodeState;
}

export function SchematicEdge({ edge, source, target, state }: Props) {
  const reduce = useReducedMotion();
  const x1 = source.x + NODE_W;
  const y1 = source.y + NODE_H / 2;
  const x2 = target.x;
  const y2 = target.y + NODE_H / 2;
  const midX = (x1 + x2) / 2;
  // orthogonal elbow: out-right, vertical at mid-channel, into the target's left
  const d = `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;

  return (
    <motion.path
      className="cr-edge"
      data-state={state}
      data-edge-id={edge.id}
      d={d}
      fill="none"
      markerEnd="url(#cr-arrow)"
      initial={reduce ? false : { pathLength: 0, opacity: 0 }}
      animate={{ pathLength: 1, opacity: 1 }}
      transition={{ duration: 0.4, ease: "easeInOut" }}
    />
  );
}
