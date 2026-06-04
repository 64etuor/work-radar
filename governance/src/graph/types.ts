/** Node kinds. handoff|pattern|hypothesis are forward-declared in master §6 but have no producer in this cut. */
export type NodeType = "decision" | "task" | "plan" | "session" | "spec";

export type EdgeType = "related_to" | "supersedes" | "refs" | "blocks" | "step_of";

export interface EventRow {
  event_id: string;
  content_hash: string;
  event_type: string;
  occurred_at: string | null;
  actor: string;
  source: string;
  subject_type: NodeType | null;
  subject_id: string | null;
  authority_decision_id: string | null;
  payload_jsonb: Record<string, unknown>;
}

export interface NodeRow {
  node_id: string; // `${node_type}:${canonical_id}`
  node_type: NodeType;
  canonical_id: string;
  title: string;
  state_jsonb: Record<string, unknown>;
}

export interface EdgeRow {
  edge_id: string; // sha256(from|type|to|source_event_id)
  from_node_id: string;
  to_node_id: string;
  edge_type: EdgeType;
  source_event_id: string;
}

export interface GraphProjection {
  events: EventRow[];
  nodes: NodeRow[];
  edges: EdgeRow[];
}

export interface IndexStatus {
  events: number;
  nodes: number;
  edges: number;
  checksum: string;
}

export interface GraphStore {
  rebuild(p: GraphProjection): Promise<void>;
  upsert(p: GraphProjection): Promise<void>;
  status(): Promise<IndexStatus>;
  getNode(id: string): Promise<NodeRow | null>;
  getNeighbors(id: string): Promise<{ node: NodeRow; edges: EdgeRow[]; neighbors: NodeRow[] } | null>;
  close(): Promise<void>;
}
