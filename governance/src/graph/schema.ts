/** Derived-cache DDL. Idempotent (IF NOT EXISTS). Embeddings column intentionally omitted —
 *  the embedding slice adds a `vector` column + the pglite/vector extension without touching this. */
export const DDL = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT,
  actor TEXT NOT NULL,
  source TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  authority_decision_id TEXT,
  payload_jsonb JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state_jsonb JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  edge_id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  source_event_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_from_idx ON edges (from_node_id);
CREATE INDEX IF NOT EXISTS edges_to_idx ON edges (to_node_id);
CREATE INDEX IF NOT EXISTS nodes_canon_idx ON nodes (canonical_id);
`;
