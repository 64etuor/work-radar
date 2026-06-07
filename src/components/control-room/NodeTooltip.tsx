import { type GraphNode, NODE_W } from "../../lib/controlRoomGraph";

export function NodeTooltip({ node }: { node: GraphNode }) {
  return (
    <div className="cr-tooltip" style={{ left: node.x + NODE_W + 10, top: node.y }} role="dialog">
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
