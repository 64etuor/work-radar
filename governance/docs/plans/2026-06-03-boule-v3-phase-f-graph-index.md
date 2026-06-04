# Boule v3 Phase F — Postgres+pgvector Derived Graph Index (first cut) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a derived, rebuildable Postgres graph index (`events` + `nodes` + `edges`) over the L0 markdown event log, backed by embedded PGlite, with on-demand `rebuild_index` + thin read MCP tools.

**Architecture:** A pure `projectGraph(events) → {events, nodes, edges}` reuses the existing per-axis folds (`projectTasks/Plans/Sessions/Specs` + `deriveDecisionState`); PGlite is dumb persistence/query. Rebuild = `TRUNCATE; bulk-insert` in one txn. Markdown is canonical; the index is a derived cache; embeddings/pgvector + `approvals`/`session_observations` are deferred.

**Tech Stack:** Node 24+ strip-types TS (this worktree runs v26; `--experimental-strip-types`; source imports `.ts`, tests import `.js`), vitest 2, zod 4, `@electric-sql/pglite` (new), MCP SDK 1.29 (`server.registerTool`).

**Spec:** `governance/docs/design/2026-06-03-boule-v3-phase-f-graph-index-design.md`

**Working dir for ALL commands:** `/Users/davidpark/private_project/work-radar/.claude/worktrees/boule-v3-phase-d/governance`

**Conventions (read before starting):**
- Source files import sibling modules with `.ts` extension; **test files import the module under test with `.js`** (e.g. `import { projectGraph } from "../../src/graph/project.js";`). This matches every existing `test/**` file.
- Commit governance with `git commit --no-verify` (the worktree lacks the root husky deps; root hooks target the app). Never `git push` / merge / deploy.
- Do NOT run Prettier on governance files (no prettier dep; aligned-comment local style — running it = churn).
- Gates after each task: `pnpm exec tsc --noEmit` (expect 0) and `pnpm exec vitest run` (must stay green; baseline 371).
- `*/` trap: never write the literal token `task_` or `decision_` followed by `*/` inside a `/** */` block comment — it terminates the comment early (TS1161). Reword.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/graph/types.ts` (create) | `EventRow`, `NodeRow`, `EdgeRow`, `GraphProjection`, `NodeType`, `EdgeType`, `IndexStatus`, `GraphStore`. |
| `src/graph/checksum.ts` (create) | `stableStringify`, `checksumProjection` — deterministic sha256 over sorted rows. |
| `src/graph/project.ts` (create) | Pure `projectGraph` + helpers `toEventRows`, `subjectOf`, `toNodeRows`, `toEdgeRows`. Reuses per-axis folds. No I/O, emits no events. |
| `src/graph/schema.ts` (create) | DDL strings for `events`/`nodes`/`edges` (+ indexes). |
| `src/graph/store.ts` (create) | PGlite store: `openStore`, `rebuild`, `status`, `getNode`, `getNeighbors`. Only I/O. |
| `src/graph/ingest.ts` (create) | `rebuildIndex(workspaceDir, store)`: `readAllEvents` → `projectGraph` → `store.rebuild`. |
| `src/mcp/server.ts` (modify) | 4 `registerTool` blocks: `rebuild_index`, `index_status`, `graph_node`, `graph_neighbors`. |
| `test/graph/*.test.ts` (create) | project / checksum / store / rebuild-equivalence / negative. |
| `package.json` (modify) | add `@electric-sql/pglite` dependency. |
| `.gitignore` (modify) | ignore `workspace/index/`. |

---

## Task 1: Dependency + row types + checksum

**Files:**
- Modify: `package.json` (add dependency)
- Create: `src/graph/types.ts`
- Create: `src/graph/checksum.ts`
- Test: `test/graph/checksum.test.ts`

- [ ] **Step 1: Add the PGlite dependency**

Run:
```bash
pnpm add @electric-sql/pglite
```
Expected: `package.json` gains `"@electric-sql/pglite": "^0.2.x"` under `dependencies`; lockfile updates. (PGlite is pure WASM — no native build.)

- [ ] **Step 2: Create the row/projection types**

Create `src/graph/types.ts`:
```ts
/** Node kinds. handoff|pattern|hypothesis are forward-declared in §6 but have no producer in this cut. */
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
  status(): Promise<IndexStatus>;
  getNode(id: string): Promise<NodeRow | null>;
  getNeighbors(id: string): Promise<{ node: NodeRow; edges: EdgeRow[]; neighbors: NodeRow[] } | null>;
  close(): Promise<void>;
}
```

- [ ] **Step 3: Write the failing checksum test**

Create `test/graph/checksum.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { checksumProjection } from "../../src/graph/checksum.js";
import type { GraphProjection } from "../../src/graph/types.js";

const base: GraphProjection = {
  events: [
    { event_id: "b", content_hash: "h2", event_type: "task_created", occurred_at: null, actor: "u",
      source: "hermes", subject_type: "task", subject_id: "b", authority_decision_id: null, payload_jsonb: {} },
    { event_id: "a", content_hash: "h1", event_type: "task_started", occurred_at: null, actor: "u",
      source: "agent_run", subject_type: "task", subject_id: "b", authority_decision_id: null, payload_jsonb: {} },
  ],
  nodes: [
    { node_id: "task:b", node_type: "task", canonical_id: "b", title: "T", state_jsonb: { phase: "active" } },
  ],
  edges: [],
};

describe("checksumProjection", () => {
  it("is independent of input row order", () => {
    const shuffled: GraphProjection = { ...base, events: [...base.events].reverse() };
    expect(checksumProjection(base)).toBe(checksumProjection(shuffled));
  });

  it("changes when any row content changes", () => {
    const mutated: GraphProjection = {
      ...base,
      nodes: [{ ...base.nodes[0], state_jsonb: { phase: "done" } }],
    };
    expect(checksumProjection(mutated)).not.toBe(checksumProjection(base));
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `pnpm exec vitest run test/graph/checksum.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/checksum.js`.

- [ ] **Step 5: Implement checksum**

Create `src/graph/checksum.ts`:
```ts
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
```

- [ ] **Step 6: Run tests to confirm pass**

Run: `pnpm exec vitest run test/graph/checksum.test.ts`
Expected: PASS (2 tests). Then `pnpm exec tsc --noEmit` → 0.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/graph/types.ts src/graph/checksum.ts test/graph/checksum.test.ts
git commit --no-verify -m "feat(governance): Phase F — graph row types + deterministic projection checksum"
```

---

## Task 2: EventRow projection + subject derivation

**Files:**
- Create: `src/graph/project.ts` (partial — `toEventRows`, `subjectOf`, mapping tables, `occurredAt`)
- Test: `test/graph/project.test.ts` (partial — EventRow + subject cases)

- [ ] **Step 1: Write the failing test**

Create `test/graph/project.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toEventRows, subjectOf } from "../../src/graph/project.js";
import type { GovEvent } from "../../src/event/event.js";

function evt(over: Partial<GovEvent["frontmatter"]>, body = "Title line"): GovEvent {
  return {
    frontmatter: { id: "x", type: "task_created", source: "hermes", actor: "u", tags: [], ...over },
    body,
  };
}

describe("subjectOf", () => {
  it("anchors a birth event to its own id", () => {
    expect(subjectOf(evt({ id: "evt_t1", type: "task_created" }))).toEqual({
      type: "task", id: "evt_t1", relations: [],
    });
  });
  it("anchors a lifecycle event to related_to[0] and drops it from relations", () => {
    expect(subjectOf(evt({ id: "evt_s1", type: "task_started", related_to: ["evt_t1", "evt_other"] }))).toEqual({
      type: "task", id: "evt_t1", relations: ["evt_other"],
    });
  });
  it("returns null subject for non-subject event types", () => {
    expect(subjectOf(evt({ id: "evt_c1", type: "commit_recorded" }))).toEqual({
      type: null, id: null, relations: [],
    });
  });
});

describe("toEventRows", () => {
  it("derives one row per event with content_hash, occurred_at, subject", () => {
    const rows = toEventRows([evt({ id: "evt_20260603_101500_ab12", type: "task_created" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe("evt_20260603_101500_ab12");
    expect(rows[0].subject_type).toBe("task");
    expect(rows[0].subject_id).toBe("evt_20260603_101500_ab12");
    expect(rows[0].occurred_at).toBe("2026-06-03T10:15:00Z");
    expect(rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("sets authority_decision_id from a related decision proposal", () => {
    const events: GovEvent[] = [
      evt({ id: "dec_1", type: "decision_proposed" }),
      evt({ id: "evt_t1", type: "task_created", related_to: ["dec_1"] }),
    ];
    const taskRow = toEventRows(events).find((r) => r.event_id === "evt_t1")!;
    expect(taskRow.authority_decision_id).toBe("dec_1");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run test/graph/project.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/project.js`.

- [ ] **Step 3: Implement EventRow + subject derivation**

Create `src/graph/project.ts`:
```ts
import { serializeEvent, type EventType, type GovEvent } from "../event/event.ts";
import { sha256hex } from "../event/id.ts";
import type { EventRow, NodeType } from "./types.ts";

/** Which graph subject a given event type belongs to (null = no node subject in this cut). */
const SUBJECT_TYPE_OF: Partial<Record<EventType, NodeType>> = {
  task_created: "task", task_started: "task", task_blocked: "task", task_completed: "task", task_cancelled: "task",
  plan_proposed: "plan", plan_accepted: "plan", plan_revised: "plan", plan_completed: "plan", plan_archived: "plan", plan_superseded: "plan",
  spec_proposed: "spec", spec_accepted: "spec", spec_archived: "spec",
  decision_recorded: "decision", decision_proposed: "decision", decision_review_recorded: "decision",
  decision_approved: "decision", decision_rejected: "decision", decision_blocked: "decision", decision_chosen: "decision",
  session_open_requested: "session", session_opened: "session", session_spawned: "session", session_observed: "session",
  session_waiting: "session", session_blocked: "session", session_context_pressure_changed: "session",
  session_checkpoint_requested: "session", session_handoff_ready: "session", session_close_requested: "session",
  session_closed: "session", session_crashed: "session", session_recovered: "session",
};

/** Event types whose own id ESTABLISHES the subject (vs. lifecycle events that point via related_to[0]). */
const BIRTH_TYPES = new Set<EventType>([
  "task_created", "plan_proposed", "spec_proposed", "decision_proposed", "decision_recorded",
  "session_open_requested", "session_opened", "session_spawned",
]);

export interface Subject {
  type: NodeType | null;
  id: string | null;
  /** related_to entries that are real relations (subject anchor excluded for lifecycle events). */
  relations: string[];
}

/** Pure: which subject an event belongs to, and its non-anchor relations. */
export function subjectOf(e: GovEvent): Subject {
  const t = SUBJECT_TYPE_OF[e.frontmatter.type] ?? null;
  const rel = e.frontmatter.related_to ?? [];
  if (!t) return { type: null, id: null, relations: rel };
  if (BIRTH_TYPES.has(e.frontmatter.type)) return { type: t, id: e.frontmatter.id, relations: rel };
  return { type: t, id: rel[0] ?? null, relations: rel.slice(1) };
}

/** Best-effort UTC timestamp parsed from an id stamp `YYYYMMDD_HHMMSS`; null if absent. */
function occurredAt(id: string): string | null {
  const m = id.match(/(\d{8})_(\d{6})/);
  if (!m) return null;
  const [, d, t] = m;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
}

/** L0 1:1 rows. content_hash over the serialized markdown; authority = first related decision id. */
export function toEventRows(events: GovEvent[]): EventRow[] {
  const decisionIds = new Set(
    events.filter((e) => SUBJECT_TYPE_OF[e.frontmatter.type] === "decision").map((e) => subjectOf(e).id),
  );
  return events.map((e) => {
    const fm = e.frontmatter;
    const subj = subjectOf(e);
    const authority = (fm.related_to ?? []).find((r) => decisionIds.has(r)) ?? null;
    return {
      event_id: fm.id,
      content_hash: sha256hex(serializeEvent(e)),
      event_type: fm.type,
      occurred_at: occurredAt(fm.id),
      actor: fm.actor,
      source: fm.source,
      subject_type: subj.type,
      subject_id: subj.id,
      authority_decision_id: authority,
      payload_jsonb: {
        tags: fm.tags,
        related_to: fm.related_to ?? [],
        supersededBy: fm.supersededBy ?? null,
        confidence: fm.confidence ?? null,
        body: e.body,
      },
    };
  });
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm exec vitest run test/graph/project.test.ts`
Expected: PASS (5 tests). Then `pnpm exec tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add src/graph/project.ts test/graph/project.test.ts
git commit --no-verify -m "feat(governance): Phase F — EventRow projection + subject derivation"
```

---

## Task 3: NodeRow projection (reuse per-axis folds)

**Files:**
- Modify: `src/graph/project.ts` (add `toNodeRows` + decision enumerator)
- Test: `test/graph/project.test.ts` (add node cases)

- [ ] **Step 1: Add the failing test**

Append to `test/graph/project.test.ts`:
```ts
import { toNodeRows } from "../../src/graph/project.js";

describe("toNodeRows", () => {
  it("emits one node per subject across axes, reusing the folds", () => {
    const events: GovEvent[] = [
      evt({ id: "t1", type: "task_created" }, "Task one"),
      evt({ id: "ts1", type: "task_started", related_to: ["t1"] }),
      evt({ id: "p1", type: "plan_proposed" }, "Plan one"),
      evt({ id: "sp1", type: "spec_proposed" }, "Spec one"),
    ];
    const nodes = toNodeRows(events);
    const task = nodes.find((n) => n.node_id === "task:t1")!;
    expect(task.node_type).toBe("task");
    expect(task.title).toBe("Task one");
    expect(task.state_jsonb.phase).toBe("active");
    expect(nodes.map((n) => n.node_id).sort()).toEqual(["plan:p1", "spec:sp1", "task:t1"]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run test/graph/project.test.ts`
Expected: FAIL — `toNodeRows` is not exported.

- [ ] **Step 3: Implement `toNodeRows`**

Append to `src/graph/project.ts`:
```ts
import { projectTasks } from "../task/project.ts";
import { projectPlans } from "../plan/project.ts";
import { projectSessions } from "../session/project.ts";
import { projectSpecs } from "../spec/project.ts";
import { deriveDecisionState } from "../decision/decision.ts";
import { proposalsOf, eventsForDecision } from "../decision/readEvents.ts";
import type { NodeRow } from "./types.ts";

function node(type: NodeType, canonicalId: string, title: string, state: Record<string, unknown>): NodeRow {
  return { node_id: `${type}:${canonicalId}`, node_type: type, canonical_id: canonicalId, title, state_jsonb: state };
}

/** Reuse the existing per-axis folds (god-fold ban, master §8). One node per live subject. */
export function toNodeRows(events: GovEvent[]): NodeRow[] {
  const rows: NodeRow[] = [];
  for (const s of projectTasks(events)) rows.push(node("task", s.taskId, s.title, { phase: s.phase, verdict: s.verdict }));
  for (const s of projectPlans(events)) rows.push(node("plan", s.planId, s.title, { phase: s.phase }));
  for (const s of projectSessions(events)) rows.push(node("session", s.sessionId, s.sessionId, { phase: s.phase, ownership: s.ownership, taskId: s.taskId }));
  for (const s of projectSpecs(events)) rows.push(node("spec", s.specId, s.title, { phase: s.phase }));
  for (const p of proposalsOf(events)) {
    const s = deriveDecisionState(p, eventsForDecision(events, p.frontmatter.id).related, 1);
    rows.push(node("decision", s.decisionId, s.title, { phase: s.phase, verdict: s.verdict }));
  }
  return rows;
}
```
> Note: `projectSessions` rows carry `{ sessionId, ownership, taskId, phase }` (no title) — use `sessionId` as the node title. `deriveDecisionState(proposal, related, quorum)` — quorum `1` is the read-side default (matches existing `decisions`/`task` read commands).

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm exec vitest run test/graph/project.test.ts`
Expected: PASS (6 tests). Then `pnpm exec tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add src/graph/project.ts test/graph/project.test.ts
git commit --no-verify -m "feat(governance): Phase F — NodeRow projection reusing per-axis folds"
```

---

## Task 4: EdgeRow projection

**Files:**
- Modify: `src/graph/project.ts` (add `toEdgeRows`)
- Test: `test/graph/project.test.ts` (add edge cases)

- [ ] **Step 1: Add the failing test**

Append to `test/graph/project.test.ts`:
```ts
import { toEdgeRows } from "../../src/graph/project.js";

describe("toEdgeRows", () => {
  const events: GovEvent[] = [
    evt({ id: "t1", type: "task_created" }, "Task one"),
    evt({ id: "p1", type: "plan_proposed" }, "Plan one"),
    evt({ id: "p2", type: "plan_proposed" }, "Plan two"),
    evt({ id: "sup1", type: "plan_superseded", related_to: ["p1"], supersededBy: "p2" }),
    evt({ id: "sb1", type: "step_bound", related_to: ["p1", "t1"] }),
    // Real escalate.ts shape: decision_blocked related_to = [decisionId, taskId]; decision node = the proposal.
    evt({ id: "dec1", type: "decision_proposed" }, "Decision one"),
    evt({ id: "db1", type: "decision_blocked", related_to: ["dec1", "t1"] }, "Blocked fork"),
  ];
  const nodes = toNodeRows(events);
  const edges = toEdgeRows(events, nodes);
  const has = (type: string, from: string, to: string) =>
    edges.some((e) => e.edge_type === type && e.from_node_id === from && e.to_node_id === to);

  it("emits supersedes from the superseded plan to its replacement", () => {
    expect(has("supersedes", "plan:p1", "plan:p2")).toBe(true);
  });
  it("emits step_of from task to plan for a step_bound", () => {
    expect(has("step_of", "task:t1", "plan:p1")).toBe(true);
  });
  it("emits blocks from the decision proposal to the blocked task", () => {
    expect(has("blocks", "decision:dec1", "task:t1")).toBe(true);
  });
  it("produces deterministic edge ids (stable across reruns)", () => {
    expect(toEdgeRows(events, nodes).map((e) => e.edge_id)).toEqual(edges.map((e) => e.edge_id));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run test/graph/project.test.ts`
Expected: FAIL — `toEdgeRows` is not exported.

- [ ] **Step 3: Implement `toEdgeRows`**

Append to `src/graph/project.ts`:
```ts
import { sha256hex as sha } from "../event/id.ts";
import type { EdgeRow, EdgeType } from "./types.ts";

/** Derive reference edges from event relations. Endpoints must resolve to emitted nodes
 *  (except refs, which retain a possibly-dangling raw target — never silently dropped). */
export function toEdgeRows(events: GovEvent[], nodes: NodeRow[]): EdgeRow[] {
  const byCanon = new Map<string, NodeRow>();
  for (const n of nodes) byCanon.set(n.canonical_id, n);
  const edges: EdgeRow[] = [];
  const push = (from: string, to: string, type: EdgeType, src: string) =>
    edges.push({ edge_id: sha(`${from}|${type}|${to}|${src}`), from_node_id: from, to_node_id: to, edge_type: type, source_event_id: src });

  for (const e of events) {
    const fm = e.frontmatter;

    // step_bound binds two existing nodes but mints no subject node of its own (§3.2).
    if (fm.type === "step_bound") {
      const targets = (fm.related_to ?? []).map((r) => byCanon.get(r)).filter((n): n is NodeRow => !!n);
      const task = targets.find((n) => n.node_type === "task");
      const plan = targets.find((n) => n.node_type === "plan");
      if (task && plan) push(task.node_id, plan.node_id, "step_of", fm.id);
      continue;
    }

    const subj = subjectOf(e);
    const fromNode = subj.type && subj.id ? byCanon.get(subj.id) : undefined;
    if (!fromNode) continue; // no resolvable subject → no edge endpoint in this cut
    const from = fromNode.node_id;

    if (fm.supersededBy) {
      const target = byCanon.get(fm.supersededBy);
      push(from, target ? target.node_id : fm.supersededBy, "supersedes", fm.id);
    }
    for (const r of subj.relations) {
      const target = byCanon.get(r);
      const type: EdgeType = fm.type === "decision_blocked" ? "blocks" : target ? "related_to" : "refs";
      push(from, target ? target.node_id : r, type, fm.id);
    }
  }
  return edges;
}
```
> `decision_blocked` is a lifecycle decision event with `related_to = [decisionId, taskId]` (verified in `src/escalate/escalate.ts`): `subjectOf` anchors to `related_to[0]` (the decision) and `subj.relations = [taskId]` → a `blocks` edge from the decision node to the task. `escalate()` always co-mints `decision_proposed` + `decision_blocked`, so the decision node always exists and the edge resolves. **Orphan case** (a `decision_blocked` with no preceding proposal → no from-node): the `blocks` edge is dropped (spec §3.4 "Known limitation"); it cannot occur via the current producer. The Task 7 multi-axis fixture asserts the resolved case end-to-end.

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm exec vitest run test/graph/project.test.ts`
Expected: PASS (10 tests). Then `pnpm exec tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add src/graph/project.ts test/graph/project.test.ts
git commit --no-verify -m "feat(governance): Phase F — EdgeRow projection (supersedes/step_of/blocks/related_to/refs)"
```

---

## Task 5: Compose `projectGraph` + determinism

**Files:**
- Modify: `src/graph/project.ts` (add `projectGraph`)
- Test: `test/graph/project.test.ts` (add compose + determinism case)

- [ ] **Step 1: Add the failing test**

Append to `test/graph/project.test.ts`:
```ts
import { projectGraph } from "../../src/graph/project.js";
import { checksumProjection } from "../../src/graph/checksum.js";

describe("projectGraph", () => {
  const events: GovEvent[] = [
    evt({ id: "t1", type: "task_created" }, "Task one"),
    evt({ id: "ts1", type: "task_started", related_to: ["t1"] }),
    evt({ id: "p1", type: "plan_proposed" }, "Plan one"),
  ];
  it("returns sorted events/nodes/edges and is order-independent by checksum", () => {
    const a = projectGraph(events);
    const b = projectGraph([...events].reverse());
    expect(checksumProjection(a)).toBe(checksumProjection(b));
    expect(a.events.map((e) => e.event_id)).toEqual([...a.events.map((e) => e.event_id)].sort());
  });
  it("emits no events and touches no globals (pure)", () => {
    const before = JSON.stringify(events);
    projectGraph(events);
    expect(JSON.stringify(events)).toBe(before); // input not mutated
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run test/graph/project.test.ts`
Expected: FAIL — `projectGraph` is not exported.

- [ ] **Step 3: Implement `projectGraph`**

Append to `src/graph/project.ts`:
```ts
import type { GraphProjection } from "./types.ts";

/** PURE: events → derived graph projection. Reuses per-axis folds; no I/O, emits no events.
 *  Output rows are PK-sorted so the projection (and its checksum) is order-independent. */
export function projectGraph(events: GovEvent[]): GraphProjection {
  const nodes = toNodeRows(events);
  return {
    events: toEventRows(events).sort((a, b) => a.event_id.localeCompare(b.event_id)),
    nodes: nodes.sort((a, b) => a.node_id.localeCompare(b.node_id)),
    edges: toEdgeRows(events, nodes).sort((a, b) => a.edge_id.localeCompare(b.edge_id)),
  };
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm exec vitest run test/graph/project.test.ts`
Expected: PASS (12 tests). Then `pnpm exec tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add src/graph/project.ts test/graph/project.test.ts
git commit --no-verify -m "feat(governance): Phase F — compose projectGraph (pure, sorted, deterministic)"
```

---

## Task 6: PGlite schema + store

**Files:**
- Create: `src/graph/schema.ts`
- Create: `src/graph/store.ts`
- Test: `test/graph/store.test.ts`

- [ ] **Step 1: Create the DDL**

Create `src/graph/schema.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing store test**

Create `test/graph/store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { openStore } from "../../src/graph/store.js";
import { projectGraph } from "../../src/graph/project.js";
import { checksumProjection } from "../../src/graph/checksum.js";
import type { GovEvent } from "../../src/event/event.js";

function evt(over: Partial<GovEvent["frontmatter"]>, body = "Title"): GovEvent {
  return { frontmatter: { id: "x", type: "task_created", source: "hermes", actor: "u", tags: [], ...over }, body };
}

const events: GovEvent[] = [
  evt({ id: "t1", type: "task_created" }, "Task one"),
  evt({ id: "ts1", type: "task_started", related_to: ["t1"] }),
  evt({ id: "p1", type: "plan_proposed" }, "Plan one"),
];

describe("graph store (PGlite :memory:)", () => {
  it("rebuilds, reports status, and round-trips checksum equal to the projection", async () => {
    const store = await openStore(":memory:");
    const proj = projectGraph(events);
    await store.rebuild(proj);
    const st = await store.status();
    expect(st.nodes).toBe(proj.nodes.length);
    expect(st.events).toBe(proj.events.length);
    expect(st.checksum).toBe(checksumProjection(proj));
    await store.close();
  });

  it("is idempotent — rebuild twice yields the identical checksum", async () => {
    const store = await openStore(":memory:");
    await store.rebuild(projectGraph(events));
    const first = (await store.status()).checksum;
    await store.rebuild(projectGraph(events)); // TRUNCATE + reinsert
    expect((await store.status()).checksum).toBe(first);
    await store.close();
  });

  it("serves getNode and getNeighbors", async () => {
    const store = await openStore(":memory:");
    await store.rebuild(projectGraph(events));
    const t1 = await store.getNode("task:t1");
    expect(t1?.title).toBe("Task one");
    expect(t1?.state_jsonb.phase).toBe("active"); // state_jsonb survives the DB round-trip field-for-field
    expect(await store.getNode("task:missing")).toBeNull();
    const nb = await store.getNeighbors("task:t1");
    expect(nb?.node.node_id).toBe("task:t1");
    await store.close();
  });

  it("the :memory: sentinel creates no on-disk dir (truly ephemeral)", async () => {
    const { existsSync } = await import("node:fs");
    const store = await openStore(":memory:");
    await store.rebuild(projectGraph(events));
    expect(existsSync(":memory:")).toBe(false); // sentinel must NOT be forwarded to PGlite as a path
    await store.close();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm exec vitest run test/graph/store.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/store.js`.

- [ ] **Step 4: Implement the store**

Create `src/graph/store.ts`:
```ts
import { PGlite } from "@electric-sql/pglite";
import { DDL } from "./schema.ts";
import { checksumProjection } from "./checksum.ts";
import type { EdgeRow, GraphProjection, GraphStore, IndexStatus, NodeRow } from "./types.ts";

/** Open an embedded PGlite store. ":memory:" is a SENTINEL → PGlite's no-arg in-memory mode
 *  (NOT a path; PGlite's own ephemeral URI is `memory://`). Any other value is a data dir. */
export async function openStore(loc: string): Promise<GraphStore> {
  const db = loc === ":memory:" ? new PGlite() : new PGlite(loc);
  await db.exec(DDL);

  const readAll = async (): Promise<GraphProjection> => ({
    events: (await db.query<EventRowDb>("SELECT * FROM events")).rows.map(fromEventDb),
    nodes: (await db.query<NodeRow>("SELECT * FROM nodes")).rows.map(fromNodeDb),
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
    async getNode(id: string): Promise<NodeRow | null> {
      const r = await db.query<NodeRow>("SELECT * FROM nodes WHERE node_id = $1", [id]);
      return r.rows[0] ? fromNodeDb(r.rows[0]) : null;
    },
    async getNeighbors(id: string) {
      const node = await this.getNode(id);
      if (!node) return null;
      const e = await db.query<EdgeRow>("SELECT * FROM edges WHERE from_node_id = $1 OR to_node_id = $1", [id]);
      const ids = new Set<string>();
      for (const x of e.rows) { ids.add(x.from_node_id); ids.add(x.to_node_id); }
      ids.delete(id);
      const neighbors: NodeRow[] = [];
      for (const nid of ids) { const n = await this.getNode(nid); if (n) neighbors.push(n); }
      return { node, edges: e.rows, neighbors };
    },
    async close() { await db.close(); },
  };
}

interface EventRowDb { event_id: string; content_hash: string; event_type: string; occurred_at: string | null; actor: string; source: string; subject_type: string | null; subject_id: string | null; authority_decision_id: string | null; payload_jsonb: unknown; }
function fromEventDb(r: EventRowDb) {
  return { ...r, subject_type: r.subject_type as NodeRow["node_type"] | null, payload_jsonb: typeof r.payload_jsonb === "string" ? JSON.parse(r.payload_jsonb) : (r.payload_jsonb as Record<string, unknown>) } as GraphProjection["events"][number];
}
function fromNodeDb(r: NodeRow) {
  return { ...r, state_jsonb: typeof r.state_jsonb === "string" ? JSON.parse(r.state_jsonb as unknown as string) : r.state_jsonb } as NodeRow;
}
```
> PGlite returns `JSONB` as parsed objects already; the `typeof === "string"` guards make the mapper tolerant either way. If `TRUNCATE a; TRUNCATE b;` via `tx.exec` errors in PGlite, fall back to `DELETE FROM` per table — adjust in Step 5 if the test surfaces it.

- [ ] **Step 5: Run tests to confirm pass**

Run: `pnpm exec vitest run test/graph/store.test.ts`
Expected: PASS (3 tests). If a PGlite API mismatch appears (e.g. `transaction`/`exec` signature), fix the call to match the installed `@electric-sql/pglite` version, keeping behavior identical. Then `pnpm exec tsc --noEmit` → 0.

- [ ] **Step 6: Commit**

```bash
git add src/graph/schema.ts src/graph/store.ts test/graph/store.test.ts
git commit --no-verify -m "feat(governance): Phase F — PGlite store (schema, rebuild txn, status, node/neighbors)"
```

---

## Task 7: Ingest + rebuild-equivalence + negative test

**Files:**
- Create: `src/graph/ingest.ts`
- Test: `test/graph/rebuild-equivalence.test.ts`
- Test: `test/graph/negative.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Ignore the derived data dir**

Append to `.gitignore`:
```
# Derived graph index (PGlite) — rebuildable from events via rebuild_index
workspace/index/
```

- [ ] **Step 2: Write the failing ingest entry**

Create `src/graph/ingest.ts`:
```ts
import { readAllEvents } from "../decision/readEvents.ts";
import { projectGraph } from "./project.ts";
import type { GraphStore, IndexStatus } from "./types.ts";

/** On-demand rebuild: load markdown events → pure projection → store.rebuild. Read-only over L0
 *  (reads events; writes ZERO events). Returns post-rebuild status. */
export async function rebuildIndex(workspaceDir: string, store: GraphStore): Promise<IndexStatus> {
  const events = await readAllEvents(workspaceDir);
  await store.rebuild(projectGraph(events));
  return store.status();
}
```

- [ ] **Step 3: Write rebuild-equivalence test**

Create `test/graph/rebuild-equivalence.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/graph/store.js";
import { rebuildIndex } from "../../src/graph/ingest.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { projectGraph } from "../../src/graph/project.js";
import { checksumProjection } from "../../src/graph/checksum.js";
import type { GovEvent } from "../../src/event/event.js";

async function seedWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "boule-f-"));
  const day = join(ws, "events", "2026-06-03");
  await mkdir(day, { recursive: true });
  const md = (id: string, type: string, rel?: string) =>
    `---\nid: ${id}\ntype: ${type}\nsource: hermes\nactor: u\ntags: []\n${rel ? `related_to:\n  - ${rel}\n` : ""}---\nTitle for ${id}\n`;
  await writeFile(join(day, "evt_20260603_101500_0001.md"), md("evt_20260603_101500_0001", "task_created"));
  await writeFile(join(day, "evt_20260603_101600_0002.md"), md("evt_20260603_101600_0002", "task_started", "evt_20260603_101500_0001"));
  return ws;
}

describe("rebuild equivalence (DB == markdown-derived projection)", () => {
  it("status checksum equals the pure projection checksum", async () => {
    const ws = await seedWorkspace();
    const store = await openStore(":memory:");
    const st = await rebuildIndex(ws, store);
    const expected = checksumProjection(projectGraph(await readAllEvents(ws)));
    expect(st.checksum).toBe(expected);
    await store.close();
  });

  it("is idempotent across a second rebuild", async () => {
    const ws = await seedWorkspace();
    const store = await openStore(":memory:");
    const a = await rebuildIndex(ws, store);
    const b = await rebuildIndex(ws, store);
    expect(b.checksum).toBe(a.checksum);
    await store.close();
  });

  // The real workspace may have ~0 events; this synthetic fixture exercises EVERY node + edge
  // type through projection AND DB persistence so the keystone is not proven on tasks alone.
  it("covers every node and edge type end-to-end (multi-axis fixture)", async () => {
    const f = (id: string, type: string, related?: string[], supersededBy?: string): GovEvent => ({
      frontmatter: {
        id, type: type as GovEvent["frontmatter"]["type"], source: "hermes", actor: "u", tags: [],
        ...(related ? { related_to: related } : {}), ...(supersededBy ? { supersededBy } : {}),
      },
      body: `Title ${id}`,
    });
    const events: GovEvent[] = [
      f("dec1", "decision_proposed"),
      f("db1", "decision_blocked", ["dec1", "t1"]),   // blocks: decision:dec1 → task:t1
      f("t1", "task_created"),
      f("p1", "plan_proposed"),
      f("p2", "plan_proposed"),
      f("sup1", "plan_superseded", ["p1"], "p2"),       // supersedes: plan:p1 → plan:p2
      f("sb1", "step_bound", ["p1", "t1"]),             // step_of: task:t1 → plan:p1
      f("sp1", "spec_proposed"),
      f("ses1", "session_spawned", ["t1", "ghost_x"]),  // related_to: session→task:t1 ; refs: session→ghost_x
    ];
    const proj = projectGraph(events);
    expect(new Set(proj.nodes.map((n) => n.node_type))).toEqual(
      new Set(["decision", "task", "plan", "spec", "session"]),
    );
    expect(new Set(proj.edges.map((e) => e.edge_type))).toEqual(
      new Set(["blocks", "supersedes", "step_of", "related_to", "refs"]),
    );

    const store = await openStore(":memory:");
    await store.rebuild(proj);
    const first = (await store.status()).checksum;
    await store.rebuild(projectGraph(events)); // idempotent + DB == pure projection
    expect((await store.status()).checksum).toBe(first);
    expect((await store.status()).checksum).toBe(checksumProjection(proj));
    await store.close();
  });
});
```

- [ ] **Step 4: Write the negative test (INVARIANT #1)**

Create `test/graph/negative.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/graph/store.js";
import { rebuildIndex } from "../../src/graph/ingest.js";

describe("graph ingest is read-only over L0 (INVARIANT #1)", () => {
  it("writes zero new event files when rebuilding the index", async () => {
    const ws = await mkdtemp(join(tmpdir(), "boule-f-neg-"));
    const day = join(ws, "events", "2026-06-03");
    await mkdir(day, { recursive: true });
    await writeFile(join(day, "evt_20260603_101500_0001.md"),
      `---\nid: evt_20260603_101500_0001\ntype: task_created\nsource: hermes\nactor: u\ntags: []\n---\nTask\n`);
    const before = (await readdir(day)).length;

    const store = await openStore(":memory:");
    await rebuildIndex(ws, store);
    await rebuildIndex(ws, store);
    await store.close();

    expect((await readdir(day)).length).toBe(before); // no events minted by the graph layer
  });
});
```

- [ ] **Step 5: Run to confirm fail, then they pass**

Run: `pnpm exec vitest run test/graph/rebuild-equivalence.test.ts test/graph/negative.test.ts`
Expected: PASS (3 tests). Then `pnpm exec tsc --noEmit` → 0 and full `pnpm exec vitest run` green.

- [ ] **Step 6: Commit**

```bash
git add .gitignore src/graph/ingest.ts test/graph/rebuild-equivalence.test.ts test/graph/negative.test.ts
git commit --no-verify -m "feat(governance): Phase F — ingest entry + rebuild-equivalence + read-only negative test"
```

---

## Task 8: MCP wiring (4 tools)

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Inspect the existing server wiring**

Run: `sed -n '1,100p' src/mcp/server.ts`
Confirm: how `WORKSPACE` / `REPO_ROOT` constants are defined, the `z` (zod) import, and the `registerTool(name, { description, inputSchema }, async cb)` shape (the `harvest` block at the bottom is the template).

- [ ] **Step 2: Open one store at startup + register the 4 tools**

Near the other imports in `src/mcp/server.ts`, add:
```ts
import { openStore } from "../graph/store.ts";
import { rebuildIndex } from "../graph/ingest.ts";
import { join } from "node:path";
```
After `const server = new McpServer(...)` (and where `WORKSPACE` is in scope), add:
```ts
const graphStore = await openStore(join(WORKSPACE, "index", "pglite"));
```
> If the server top level is not already an async context, open the store lazily inside each tool via a memoized `getStore()` instead — match the file's existing async style. Do not introduce a top-level `await` if the file is CommonJS-style ESM without it.

Then add four `registerTool` blocks (mirror the `harvest` block):
```ts
server.registerTool(
  "rebuild_index",
  { description: "L0 마크다운 이벤트 → 파생 그래프 인덱스(events+nodes+edges) 멱등 재구축", inputSchema: {} },
  async () => {
    const st = await rebuildIndex(WORKSPACE, graphStore);
    return { content: [{ type: "text", text: `index rebuilt: ${st.events} events, ${st.nodes} nodes, ${st.edges} edges (checksum ${st.checksum.slice(0, 8)})` }] };
  },
);

server.registerTool(
  "index_status",
  { description: "그래프 인덱스 행 수 + 투영 checksum", inputSchema: {} },
  async () => {
    const st = await graphStore.status();
    const text = st.events === 0 && st.nodes === 0 ? "index not built (run rebuild_index)"
      : `events ${st.events} · nodes ${st.nodes} · edges ${st.edges} · checksum ${st.checksum.slice(0, 8)}`;
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "graph_node",
  { description: "노드 1개 조회 (node_id = `${type}:${canonical_id}`)", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const n = await graphStore.getNode(id);
    return { content: [{ type: "text", text: n ? JSON.stringify(n, null, 2) : `unknown node: ${id}` }] };
  },
);

server.registerTool(
  "graph_neighbors",
  { description: "노드 + 1-hop 인접 엣지/노드", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const nb = await graphStore.getNeighbors(id);
    return { content: [{ type: "text", text: nb ? JSON.stringify(nb, null, 2) : `unknown node: ${id}` }] };
  },
);
```
> `z` is already imported in `server.ts` (other tools use `inputSchema: { ... : z.string() }`). Reuse that import; do not re-import.

- [ ] **Step 3: Verify the server compiles and the suite is green**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.
Run: `pnpm exec vitest run`
Expected: green (371 baseline + new graph tests).

- [ ] **Step 4: Smoke the MCP server boots (no crash on store open)**

Run: `node --experimental-strip-types src/mcp/server.ts < /dev/null`
Expected: starts and exits cleanly on EOF (stdio server). It must create `workspace/index/pglite/` without error. If it hangs (server waiting on stdio), Ctrl-C after ~2s is fine — the goal is "no startup crash."

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts
git commit --no-verify -m "feat(governance): Phase F — MCP wiring (rebuild_index, index_status, graph_node, graph_neighbors)"
```

---

## Task 9: Real-workspace smoke + done-criteria + INDEX mark

**Files:**
- Modify: `governance/docs/INDEX.md`

- [ ] **Step 1: Harvest + rebuild against the real workspace, twice (idempotency)**

Write a throwaway script `/tmp/boule-f-smoke.mjs` (NOT committed):
```js
import { openStore } from "./src/graph/store.ts";
import { rebuildIndex } from "./src/graph/ingest.ts";
const WS = new URL("./workspace", import.meta.url).pathname;
const store = await openStore(":memory:");
const a = await rebuildIndex(WS, store);
const b = await rebuildIndex(WS, store);
console.log("run1", a);
console.log("run2", b);
console.log("idempotent:", a.checksum === b.checksum);
await store.close();
```
Run: `node --experimental-strip-types /tmp/boule-f-smoke.mjs`
Expected: `run1`/`run2` show equal `events`/`nodes`/`edges`/`checksum`; `idempotent: true`. (Record the counts for the INDEX line.)

> If the real workspace has 0 events (gitignored), first run `pnpm mcp`-equivalent `harvest`, or seed via the existing decision/task fixtures. A 0-event index that round-trips checksum-equal still satisfies criteria 1-3; note "N events" honestly.

- [ ] **Step 2: Confirm bindings + app DB untouched (INVARIANT #4, #6)**

Run from the worktree root (`/Users/davidpark/private_project/work-radar/.claude/worktrees/boule-v3-phase-d`):
```bash
git -C . diff --stat -- src/bindings.ts
git -C . status --short -- src-tauri/migrations
```
Expected: both empty (no governance change touches `src/bindings.ts` or app migrations).

- [ ] **Step 3: Full gate**

Run (in `governance/`):
```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
```
Expected: tsc 0; vitest green; record the new total (371 + ~17 new graph tests).

- [ ] **Step 4: Mark Phase F DONE in INDEX**

In `governance/docs/INDEX.md`, update the §40-55 master table row **F** from `(예정)` to a DONE line:
```
| **F** | Postgres+pgvector 그래프 인덱스 (events+nodes+edges, PGlite; 임베딩 deferred) | E | `design/2026-06-03-boule-v3-phase-f-graph-index-design.md` + `plans/2026-06-03-boule-v3-phase-f-graph-index.md` (`<commit>`) ✅ DONE (critic ACCEPT, vitest <N>; rebuild 멱등 checksum-equal, read-only 0 L0 write-path) |
```
Also flip the §57-65 "P3 Postgres/pgvector → v3 Phase F" line to ✅ if present.

- [ ] **Step 5: Commit**

```bash
git add governance/docs/INDEX.md
git commit --no-verify -m "docs(governance): mark Phase F DONE in INDEX (graph index, PGlite, vitest <N>)"
```

---

## STOP — critic gate (do not self-approve)

After Task 9, **do not declare done.** Request a **separate critic pass** (opus, fresh context) against:
- the spec (`design/2026-06-03-boule-v3-phase-f-graph-index-design.md`),
- the diff,
- INVARIANTs #1/#4/#5/#6 specifically (read-only L0, bindings unchanged, no polling loop/bounded, app DB untouched).

Only on critic **ACCEPT (0 blockers)** is Phase F done. Then update memory and report. **Never push/merge** without explicit user request — the branch stays PARKED.

---

## Plan-level critic (2026-06-03 — completed before implementation)

A separate opus critic reviewed this spec + plan against the as-built code: **ACCEPT-WITH-NITS, 0
blockers**. It independently verified every reused signature (`projectTasks/Plans/Sessions/Specs`,
`deriveDecisionState`, `proposalsOf`/`eventsForDecision`), the `decision_blocked` `related_to=[decisionId, taskId]`
shape (`src/escalate/escalate.ts`), `SessionState` having no `title`, the top-level-async MCP server,
the `.js` test convention, and INVARIANTs #1/#4/#5/#6. Nits folded in here: (a) PGlite `:memory:`
sentinel documented + ephemerality assertion added (Task 6); (b) orphan-`decision_blocked` `blocks`-edge
drop documented (spec §3.4, Task 4); (c) multi-axis fixture exercising **every** node + edge type added
(Task 7); (d) `state_jsonb` round-trip assertion added (Task 6); (e) Node version label corrected.
**This is the PLAN critic — the Task 9 STOP gate still requires a SEPARATE critic on the implemented diff.**

---

## Self-Review (author checklist — completed)

- **Spec coverage:** §2.1 files → Tasks 1-8; §3.1 EventRow → Task 2; §3.2 subject → Task 2; §3.3 nodes → Task 3; §3.4 edges → Task 4; §3.5 determinism → Tasks 1,5; §4 store → Task 6; §5 tests → Tasks 1-7 (project/checksum/store/rebuild-equivalence/negative all present); §6 MCP → Task 8; §7 done-criteria → Task 9; §1 INVARIANTs → Task 9 Step 2 + negative test. No gap.
- **Placeholder scan:** none — every code step has full code; the two "if API mismatch" notes (PGlite, server async style) are explicit fallbacks, not placeholders.
- **Type consistency:** `projectGraph`/`toEventRows`/`toNodeRows`/`toEdgeRows`/`subjectOf`/`checksumProjection`/`openStore`/`rebuildIndex` names and signatures match across Tasks 1-9; `NodeRow`/`EdgeRow`/`EventRow`/`GraphProjection`/`IndexStatus`/`GraphStore` defined in Task 1 and used consistently. node_id format `${type}:${canonical_id}` consistent (Tasks 3,4,6,8).
- **Inference flags for the implementer:** PGlite (`@electric-sql/pglite`) exact `transaction`/`exec`/`query` API + `decision_blocked` real-harness `related_to` shape are confirmed at Tasks 6 Step 5 and 4 Step 3 via the running tests/smoke — adjust calls to the installed versions if a test surfaces a mismatch, keeping behavior identical.
