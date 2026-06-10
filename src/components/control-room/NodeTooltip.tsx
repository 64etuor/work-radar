import { type GraphNode, NODE_W } from "../../lib/controlRoomGraph";

export function NodeTooltip({ node, docked = false }: { node: GraphNode; docked?: boolean }) {
  // SVG canvas: anchor absolutely beside the node. Rightmost (handoff) lane:
  // anchor to the node's left so the card doesn't overflow the canvas edge.
  // Docked (React Flow Panel): the Panel positions it; drop the absolute coords.
  const flip = node.lane === "handoff";
  return (
    <div
      className="cr-tooltip"
      data-flip={(!docked && flip) || undefined}
      data-docked={docked || undefined}
      style={docked ? undefined : { left: flip ? node.x - 10 : node.x + NODE_W + 10, top: node.y }}
      role="dialog"
    >
      <div className="cr-tooltip-lane">{node.lane}</div>
      <div className="cr-tooltip-title">{node.label}</div>
      <dl className="cr-tooltip-meta">
        <div>
          <dt>phase</dt>
          <dd data-tone={node.tone}>{node.phase}</dd>
        </div>
        {node.ownership && (
          <div>
            <dt>owner</dt>
            <dd>{node.ownership}</dd>
          </div>
        )}
        <div>
          <dt>id</dt>
          <dd className="cr-tooltip-id">{node.rawId}</dd>
        </div>
      </dl>
    </div>
  );
}
