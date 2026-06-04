import { describe, expect, it } from "vitest";
import { openPostgresGraphStore } from "../../src/graph/postgres.js";
import type { EdgeRow, EventRow, NodeRow } from "../../src/graph/types.js";

class FakePostgresClient {
  execs: string[] = [];
  queries: Array<{ sql: string; params: unknown[] }> = [];
  transactions = 0;

  constructor(
    private readonly rows: {
      events?: EventRow[];
      nodes?: NodeRow[];
      edges?: EdgeRow[];
    } = {},
  ) {}

  async exec(sql: string): Promise<void> {
    this.execs.push(sql);
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });
    if (sql === "SELECT * FROM events") return { rows: (this.rows.events ?? []) as T[] };
    if (sql === "SELECT * FROM nodes") return { rows: (this.rows.nodes ?? []) as T[] };
    if (sql === "SELECT * FROM edges") return { rows: (this.rows.edges ?? []) as T[] };
    if (sql.startsWith("SELECT * FROM nodes WHERE node_id = $1")) {
      return { rows: (this.rows.nodes ?? []).filter((n) => n.node_id === params[0]) as T[] };
    }
    if (sql.startsWith("SELECT * FROM edges WHERE from_node_id = $1 OR to_node_id = $1")) {
      return {
        rows: (this.rows.edges ?? []).filter((e) => e.from_node_id === params[0] || e.to_node_id === params[0]) as T[],
      };
    }
    return { rows: [] };
  }

  async transaction<T>(fn: (tx: FakePostgresClient) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn(this);
  }

  async close(): Promise<void> {}
}

const event: EventRow = {
  event_id: "evt_1",
  content_hash: "hash_1",
  event_type: "task_created",
  occurred_at: "2026-06-04T00:00:00.000Z",
  actor: "tester",
  source: "fixture",
  subject_type: "task",
  subject_id: "TASK-1",
  authority_decision_id: null,
  payload_jsonb: { title: "Task 1" },
};

const taskNode: NodeRow = {
  node_id: "task:TASK-1",
  node_type: "task",
  canonical_id: "TASK-1",
  title: "Task 1",
  state_jsonb: { state: "open" },
};

const planNode: NodeRow = {
  node_id: "plan:PLAN-1",
  node_type: "plan",
  canonical_id: "PLAN-1",
  title: "Plan 1",
  state_jsonb: { state: "active" },
};

const edge: EdgeRow = {
  edge_id: "edge_1",
  from_node_id: taskNode.node_id,
  to_node_id: planNode.node_id,
  edge_type: "step_of",
  source_event_id: event.event_id,
};

describe("Postgres graph store adapter", () => {
  it("bootstraps the events/nodes/edges schema without exposing credential text in SQL", async () => {
    const client = new FakePostgresClient();

    await openPostgresGraphStore({
      connectionRef: "work-radar/dev",
      credential: "postgres://credential-body-from-keyring",
      client,
    });

    expect(client.execs).toHaveLength(1);
    expect(client.execs[0]).toContain("CREATE TABLE IF NOT EXISTS events");
    expect(client.execs[0]).toContain("CREATE TABLE IF NOT EXISTS nodes");
    expect(client.execs[0]).toContain("CREATE TABLE IF NOT EXISTS edges");
    expect(client.execs.join("\n")).not.toContain("credential-body-from-keyring");
  });

  it("implements rebuild through the existing GraphStore projection contract", async () => {
    const client = new FakePostgresClient();
    const store = await openPostgresGraphStore({
      connectionRef: "work-radar/dev",
      credential: "postgres://resolved-by-keyring",
      client,
    });

    await store.rebuild({ events: [event], nodes: [taskNode], edges: [edge] });

    expect(client.transactions).toBe(1);
    expect(client.queries[0]?.sql).toBe("TRUNCATE events; TRUNCATE nodes; TRUNCATE edges;");
    expect(client.queries.map((q) => q.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("INSERT INTO events"),
      expect.stringContaining("INSERT INTO nodes"),
      expect.stringContaining("INSERT INTO edges"),
    ]));
    expect(JSON.stringify(client.queries)).not.toContain("resolved-by-keyring");
  });

  it("implements upsert through inserts plus stale-row deletes inside one transaction", async () => {
    const client = new FakePostgresClient();
    const store = await openPostgresGraphStore({
      connectionRef: "work-radar/dev",
      credential: "postgres://resolved-by-keyring",
      client,
    });

    await store.upsert({ events: [event], nodes: [taskNode], edges: [edge] });

    expect(client.transactions).toBe(1);
    expect(client.queries.map((q) => q.sql)).toEqual([
      expect.stringContaining("INSERT INTO events"),
      expect.stringContaining("INSERT INTO nodes"),
      expect.stringContaining("INSERT INTO edges"),
      "DELETE FROM edges WHERE NOT (edge_id = ANY($1))",
      "DELETE FROM nodes WHERE NOT (node_id = ANY($1))",
      "DELETE FROM events WHERE NOT (event_id = ANY($1))",
    ]);
    expect(client.queries.at(-3)?.params).toEqual([[edge.edge_id]]);
    expect(client.queries.at(-2)?.params).toEqual([[taskNode.node_id]]);
    expect(client.queries.at(-1)?.params).toEqual([[event.event_id]]);
    expect(JSON.stringify(client.queries)).not.toContain("resolved-by-keyring");
  });

  it("reads status, nodes, and neighbors from a fake client deterministically", async () => {
    const client = new FakePostgresClient({
      events: [event],
      nodes: [taskNode, planNode],
      edges: [edge],
    });
    const store = await openPostgresGraphStore({
      connectionRef: "work-radar/dev",
      credential: "postgres://resolved-by-keyring",
      client,
    });

    await expect(store.status()).resolves.toMatchObject({ events: 1, nodes: 2, edges: 1 });
    await expect(store.getNode(taskNode.node_id)).resolves.toEqual(taskNode);
    await expect(store.getNeighbors(taskNode.node_id)).resolves.toEqual({
      node: taskNode,
      edges: [edge],
      neighbors: [planNode],
    });
  });
});
