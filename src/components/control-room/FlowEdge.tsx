import { BaseEdge, type EdgeProps, getSmoothStepPath } from "@xyflow/react";

/**
 * Read-only orthogonal edge. `data.active` drives the dashed flow animation
 * (CSS `cr-flow-dash`, prefers-reduced-motion gated); `data.dim` quiets idle
 * edges when a lineage/vitals focus is pinned. Matches the SVG schematic's
 * elbow routing via getSmoothStepPath (borderRadius 0 = sharp elbow).
 */
export function FlowEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 4,
  });
  const active = Boolean((data as { active?: boolean } | undefined)?.active);
  const dim = Boolean((data as { dim?: boolean } | undefined)?.dim);
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      className="cr-flow-edge"
      data-active={active || undefined}
      data-dim={dim || undefined}
    />
  );
}
