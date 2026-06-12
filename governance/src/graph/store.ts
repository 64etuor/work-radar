import { PGlite } from "@electric-sql/pglite";
import { DDL } from "./schema.ts";
import { checksumProjection } from "./checksum.ts";
import type { EdgeRow, EventRow, GraphProjection, GraphStore, IndexStatus, NodeRow, NodeType } from "./types.ts";

interface NodeRowDb { node_id: string; node_type: string; canonical_id: string; title: string; state_jsonb: unknown; }
interface EventRowDb {
  event_id: string; content_hash: string; event_type: string; occurred_at: string | null;
  actor: string; source: string; subject_type: string | null; subject_id: string | null;
  authority_decision_id: string | null; payload_jsonb: unknown;
}

/** PGlite returns JSONB as a parsed object; tolerate a string just in case. */
function asObj(v: unknown): Record<string, unknown> {
  return typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : (v as Record<string, unknown>);
}
function fromNodeDb(r: NodeRowDb): NodeRow {
  return { node_id: r.node_id, node_type: r.node_type as NodeType, canonical_id: r.canonical_id, title: r.title, state_jsonb: asObj(r.state_jsonb) };
}
function fromEventDb(r: EventRowDb): EventRow {
  return { ...r, subject_type: r.subject_type as NodeType | null, payload_jsonb: asObj(r.payload_jsonb) };
}

/** Open an embedded PGlite store. ":memory:" is a SENTINEL → PGlite's no-arg in-memory mode
 *  (NOT a path; PGlite's own ephemeral URI is `memory://`). Any other value is a data dir. */
export async function openStore(loc: string): Promise<GraphStore> {
  if (loc !== ":memory:") {
    // PGlite's nodefs mkdirs the leaf data dir but NOT its parents → pre-create them.
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(loc), { recursive: true });
  }
  const db = loc === ":memory:" ? new PGlite() : new PGlite(loc);
  await db.exec(DDL);

  const getNode = async (id: string): Promise<NodeRow | null> => {
    const r = await db.query<NodeRowDb>("SELECT * FROM nodes WHERE node_id = $1", [id]);
    return r.rows[0] ? fromNodeDb(r.rows[0]) : null;
  };

  const readAll = async (): Promise<GraphProjection> => ({
    events: (await db.query<EventRowDb>("SELECT * FROM events")).rows.map(fromEventDb),
    nodes: (await db.query<NodeRowDb>("SELECT * FROM nodes")).rows.map(fromNodeDb),
    edges: (await db.query<EdgeRow>("SELECT * FROM edges")).rows,
  });

  return {
    async rebuild(p: GraphProjection) {
      await db.transaction(async (tx) => {
        await tx.exec("TRUNCATE events; TRUNCATE nodes; TRUNCATE edges;");
        for (const e of p.events) {
          await tx.query(
            "INSERT INTO events (event_id,content_hash,event_type,occurred_at,actor,source,subject_type,subject_id,authority_decision_id,payload_jsonb) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [e.event_id, e.content_hash, e.event_type, e.occurred_at, e.actor, e.source, e.subject_type, e.subject_id, e.authority_decision_id, JSON.stringify(e.payload_jsonb)],
          );
        }
        for (const n of p.nodes) {
          await tx.query(
            "INSERT INTO nodes (node_id,node_type,canonical_id,title,state_jsonb) VALUES ($1,$2,$3,$4,$5)",
            [n.node_id, n.node_type, n.canonical_id, n.title, JSON.stringify(n.state_jsonb)],
          );
        }
        for (const g of p.edges) {
          await tx.query(
            "INSERT INTO edges (edge_id,from_node_id,to_node_id,edge_type,source_event_id) VALUES ($1,$2,$3,$4,$5)",
            [g.edge_id, g.from_node_id, g.to_node_id, g.edge_type, g.source_event_id],
          );
        }
      });
    },
    async status(): Promise<IndexStatus> {
      const proj = await readAll();
      return { events: proj.events.length, nodes: proj.nodes.length, edges: proj.edges.length, checksum: checksumProjection(proj) };
    },
    getNode,
    async getNeighbors(id: string) {
      const node = await getNode(id);
      if (!node) return null;
      const e = await db.query<EdgeRow>("SELECT * FROM edges WHERE from_node_id = $1 OR to_node_id = $1", [id]);
      const ids = new Set<string>();
      for (const x of e.rows) { ids.add(x.from_node_id); ids.add(x.to_node_id); }
      ids.delete(id);
      const neighbors = (await Promise.all([...ids].map((nid) => getNode(nid)))).filter((n): n is NodeRow => n !== null);
      return { node, edges: e.rows, neighbors };
    },
    async close() { await db.close(); },
  };
}
