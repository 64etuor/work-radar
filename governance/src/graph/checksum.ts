import { sha256hex } from "../event/id.ts";
import type { GraphProjection } from "./types.ts";

/** Recursively key-sorted JSON — stable regardless of object key insertion order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",")}}`;
}

/** Deterministic sha256 (first 16 hex) over PK-sorted rows. Order- and round-trip-independent. */
export function checksumProjection(p: GraphProjection): string {
  const canon = stableStringify({
    events: [...p.events].sort((a, b) => a.event_id.localeCompare(b.event_id)),
    nodes: [...p.nodes].sort((a, b) => a.node_id.localeCompare(b.node_id)),
    edges: [...p.edges].sort((a, b) => a.edge_id.localeCompare(b.edge_id)),
  });
  return sha256hex(canon).slice(0, 16);
}
