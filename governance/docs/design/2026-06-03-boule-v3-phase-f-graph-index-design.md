# SSOT Governance Harness — Boule v3 Phase F: Postgres+pgvector Derived Graph Index (design)

- **Date**: 2026-06-03
- **Status**: design (approved in-session; pre-plan)
- **Branch**: `feat/boule-v3-phase-d` (PARKED, unpushed — commit only, never push without explicit request)
- **Master design**: `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` (§6 schema/contract, §10 phase sequence, §11 event sets, §13 INVARIANTs)
- **Depends-on**: Phase E (✅ DONE, `4f93856`). Reuses the per-axis folds/projectors built in A–E.
- **Catalog**: `governance/docs/INDEX.md` (mark ✅ DONE on critic ACCEPT).

> **One-line:** stand up a **derived, rebuildable** Postgres graph index (`events` + `nodes` + `edges`)
> over the L0 markdown event log, backed by **embedded PGlite** so it runs in vitest with no server.
> Markdown stays canonical; the index is a cache; embeddings/pgvector are deferred.

---

## 0. Problem & Framing

Boule's cross-session reasoning (Control Room graph queries, Phase H) needs a **graph view** of the
execution plane — which decision authorized which plan, which plan step bound which task, which
session observed which task. Today that lives only as per-axis in-memory folds rebuilt per call.
Master design §6/§10 fixes the answer: a **Postgres+pgvector derived index**, schema settled in this
slice, embeddings last.

This slice builds the **first valid cut** (§10): `events` + `nodes` + `edges`, **no embeddings**, with
the keystone contract — *every derived row is reconstructable from `events/*.md` alone via
`TRUNCATE; fold(events)`*.

### 0.1 Settled scope decisions (this session)

1. **DB runtime = embedded PGlite** (`@electric-sql/pglite`). Real Postgres SQL semantics + pgvector-
   capable, but runs **in-process** → idempotent-rebuild + checksum tests run in CI with no server and
   no standing-ops burden (directly answers master Risk #3). Real-server stand-up + keyring creds are a
   later slice.
2. **Tables = `events` + `nodes` + `edges`** only. Defer `approvals`, `session_observations`, embeddings.
3. **MCP surface = `rebuild_index` + `index_status` + `graph_node <id>` + `graph_neighbors <id>`** —
   on-demand rebuild (mirrors `harvest`) + thin read so the graph is demonstrable headlessly now;
   Phase H adds the UI consumer.

### 0.2 What this slice is NOT (explicit non-goals)

Embeddings / pgvector similarity · `approvals` + `session_observations` tables · incremental upsert
(full rebuild is the contract) · real Postgres-server stand-up + keyring credentials · graph queries
beyond node + 1-hop neighbors · any UI · any new L0 event type · any write to the decision rail.

---

## 1. Invariants this slice must preserve (from master §13)

| # | INVARIANT | Posture in Phase F |
| --- | --- | --- |
| 1 | automation must not penetrate the decision rail | Graph layer is **read-only projection**: no `decision_*` writes, **emits zero L0 events** (negative test). `projectGraph` is a pure total function (no I/O). |
| 2 | external tokens in keychain | PGlite is embedded/local → **no network credentials** in this cut. Real-server creds → keyring is a documented later-slice note; not introduced here. |
| 3 | external network calls in Rust | No network. PGlite is local WASM; ingest reads local markdown only. |
| 4 | IPC = specta-generated bindings | Governance MCP = **stdio** (non-subject). `src/bindings.ts` must be **byte-unchanged**. |
| 5 | bounded retry / no unbounded loops | Rebuild is **on-demand** (one MCP call). No polling loop. Bounded directory scan + single fold pass. |
| 6 | SQLite schema via migrations only | Governance index = **separate PGlite store**, app SQLite untouched. The index is not the app DB. |
| 7 | visual design = DESIGN.md | No UI in this slice. |

INVARIANT verification is a **separate critic pass** — self-approve forbidden.

### 1.1 The keystone invariant (master §2.2, §6)

> Every derived row (`events`, `nodes`, `edges`) is reconstructable from `events/*.md` alone.
> The index is a cache: `TRUNCATE; fold(events)` reproduces it bit-for-bit. No command, agent, or
> person writes index rows by any path other than the projector. A row that cannot be traced to an
> event means the schema is wrong.

This is enforced by the **rebuild-equivalence** and **idempotency** tests (§5), the structural analog
of Phase A's projection purity property test.

---

## 2. Architecture — pure projection + dumb persistence

Chosen approach (of three considered): **pure TS `projectGraph` → PGlite as a dumb persistence/query
layer.** Rejected alternatives: (②) SQL-native projection via views — duplicates the fold state-
machines in SQL, drifts from the TS folds, fights the keystone invariant; (③) incremental-upsert-only
— §6 mandates `TRUNCATE; fold(events)` rebuildability as the contract, so full rebuild is required and
incremental is a deferred optimization.

### 2.1 New module `src/graph/`

| File | Responsibility | I/O |
| --- | --- | --- |
| `graph/schema.ts` | DDL strings for `events`/`nodes`/`edges` (+ indexes). The §6 schema contract, embeddings column omitted. | none |
| `graph/types.ts` | `EventRow`, `NodeRow`, `EdgeRow`, `GraphProjection`, `NodeType`, `EdgeType`, `IndexStatus`. | none |
| `graph/project.ts` | **Pure** `projectGraph(events: GovEvent[]): GraphProjection`. Reuses `projectTasks`/`projectPlans`/`projectSessions` + a thin decision/spec subject enumerator over `deriveDecisionState`. Derives `subject_type`/`subject_id`, `content_hash`, `occurred_at`. Builds edge rows from event relations. **No I/O, emits no events.** | none |
| `graph/checksum.ts` | `checksumProjection(p): string` — deterministic sha256 over canonically-sorted rows. | none |
| `graph/store.ts` | PGlite store: `openStore(dataDir \| ":memory:")`, `rebuild(p)`, `status()`, `getNode(id)`, `getNeighbors(id)`. The **only** stateful I/O. | PGlite |
| `graph/ingest.ts` | `rebuildIndex(workspaceDir, store)`: `readAllEvents` → `projectGraph` → `store.rebuild`. On-demand entry. | fs read |

MCP wiring added to `src/mcp/server.ts` (4 `registerTool` blocks, mirroring the `harvest` block).

### 2.2 Data flow

```
workspace/events/*.md ──readAllEvents──▶ GovEvent[]
        │ (canonical, markdown SSOT)
        ▼
   projectGraph(events)            ← PURE: reuses per-axis folds; no I/O, no event emission
        │  GraphProjection { events: EventRow[], nodes: NodeRow[], edges: EdgeRow[] }
        ▼
   store.rebuild(projection)       ← TRUNCATE events,nodes,edges; bulk INSERT in one txn
        │
        ▼
   PGlite (workspace/index/pglite/ | :memory: in tests)   ← DERIVED CACHE, not canonical
        │
        ├─ status()        → { events:n, nodes:n, edges:n, checksum }
        ├─ getNode(id)     → NodeRow | null
        └─ getNeighbors(id)→ { node, edges: EdgeRow[], neighbors: NodeRow[] }
```

---

## 3. The projection — `projectGraph`

### 3.1 `EventRow` (L0 1:1, master §6)

One row per `GovEvent`, derived purely from frontmatter+body:

| column | source |
| --- | --- |
| `event_id` (PK) | `frontmatter.id` |
| `content_hash` | `sha256hex(serializeEvent(evt))` (reuses `event/id.ts`) |
| `event_type` | `frontmatter.type` |
| `occurred_at` | parsed from the id stamp `YYYYMMDD_HHMMSS` (UTC); fallback `null` if non-stamped id |
| `actor` | `frontmatter.actor` |
| `source` | `frontmatter.source` |
| `subject_type` | derived (§3.2) |
| `subject_id` | derived (§3.2) |
| `authority_decision_id` | first `related_to` that resolves to a decision subject, else `null` |
| `payload_jsonb` | `{ tags, related_to, supersededBy, confidence, body }` (lossless echo) |

> `markdown_path` from §6 is **omitted** — the harness addresses events by content/id, not path, and
> paths are gitignored runtime output. Reconstruction needs only `event_id` + `content_hash`.

### 3.2 Subject derivation (event → which graph subject it belongs to)

Events do **not** carry `subject_type`/`subject_id` in frontmatter; the projector derives them from
event type (pure mapping table) + `related_to`:

- `task_*` → subject `(task, taskId)` where `taskId = task_created.id` (for `task_created`, the event's
  own id; for lifecycle events, `related_to[0]`).
- `plan_*` → `(plan, planId)`; `spec_*` → `(spec, specId)`; `session_*`/`session_spawned` → `(session, sessionId)`.
- `decision_*` → `(decision, decisionId)` (proposal id, or `related_to[0]` for review/approve/etc.).
- `step_bound` → no own subject node; contributes a `step_of` **edge** only.
- `commit_recorded`/`pr_*`/`ci_failed`/`agent_run_completed`/`orchestrator_suggestion_created` →
  subject `(none, …)` for `EventRow` (subject_type may be `null`); they contribute edges via `related_to`
  but mint no node (no axis fold owns them as graph subjects in this cut).

The mapping lives in **one** exported table (`SUBJECT_OF: Record<EventType, NodeType | null>`) so it is
auditable and the god-fold ban (master §8) holds: the projector reuses each axis's existing fold; it
does not re-implement any state machine.

### 3.3 `NodeRow` — one per live subject, state from the reused fold

```
nodes(node_id PK = `${node_type}:${canonical_id}`,
      node_type ENUM(decision|task|plan|session|spec),   -- handoff|pattern|hypothesis deferred
      canonical_id, title, state_jsonb)
```

- `task` nodes ← `projectTasks(events)` → `{ taskId, title, phase, verdict }` → `state_jsonb`.
- `plan` nodes ← `projectPlans(events)` → `{ planId, title, phase }`.
- `session` nodes ← `projectSessions(events)` → `{ sessionId, ownership, taskId, phase, … }`.
- `decision` nodes ← thin enumerator: distinct decision subject ids → `deriveDecisionState` → `{ decisionId, title, phase, verdict, … }`.
- `spec` nodes ← thin enumerator over `spec_*` events (id + latest lifecycle phase).

`pattern`/`hypothesis`/`handoff` node types exist in the §6 ENUM but have **no producer in this cut** →
not emitted (documented gap; the ENUM is forward-declared).

### 3.4 `EdgeRow` — from event relations

```
edges(edge_id PK, from_node_id, to_node_id,
      edge_type ENUM(related_to|supersedes|refs|blocks|step_of),
      source_event_id)
```

Derivation (pure, from each event):

| edge_type | from → to | source |
| --- | --- | --- |
| `supersedes` | newer plan → `supersededBy` target | `plan_superseded` (or any event with `supersededBy`) |
| `step_of` | task → plan | `step_bound` (`related_to` = [planId/stepRef, taskId]) |
| `blocks` | `decision_blocked` subject → the task/plan it blocks | `decision_blocked` `related_to` |
| `related_to` | event subject → each `related_to` target that resolves to a known node | any event with `related_to` |
| `refs` | event subject → `related_to` target that does **not** resolve to a node subject (raw ref) | any event |

`edge_id` is deterministic: `sha256hex(from + "|" + edge_type + "|" + to + "|" + source_event_id)` — so
rebuild produces identical ids (idempotency). Edges whose endpoints don't both resolve to emitted nodes are
**dropped** for `related_to`/`supersedes`/`step_of`/`blocks` (graph integrity) and retained only as
`refs` with a possibly-dangling `to` recorded as the raw id string — documented, so the graph never
silently loses a reference.

> **Known limitation (orphan `decision_blocked`):** a `blocks` edge needs its **from**-node (the
> decision) to resolve. In the live harness `escalate()` always co-mints `decision_proposed` +
> `decision_blocked` (`src/escalate/escalate.ts`), so the decision node exists and the edge resolves.
> If a `decision_blocked` were ever ingested *without* a preceding proposal, no decision node exists
> and the `blocks` edge is **dropped** (not degraded to `refs`, because there is no from-endpoint to
> anchor). This is the one accepted gap in the no-silent-loss rule; it cannot occur via the current
> producer. Revisit if a standalone `decision_blocked` producer is ever added.

### 3.5 Determinism

`projectGraph` sorts all output rows by PK before returning (events by `event_id`, nodes by `node_id`,
edges by `edge_id`). `checksumProjection` hashes the canonically-serialized sorted rows. Same event set
→ same checksum, regardless of input order or DB round-trip.

---

## 4. The store — PGlite

- `openStore(loc)`: `loc = ":memory:"` (tests) or a data dir (`workspace/index/pglite/`, gitignored).
  Runs `schema.ts` DDL (idempotent `CREATE TABLE IF NOT EXISTS` + indexes) on open.
- `rebuild(projection)`: single transaction — `TRUNCATE events, nodes, edges` → bulk `INSERT` the sorted
  rows → commit. No partial state on failure (txn rollback).
- `status()`: `SELECT count(*)` per table + recompute `checksumProjection` from the **DB-read** rows
  (proves the DB faithfully holds the projection, not just that we inserted it).
- `getNode(id)`: `SELECT … WHERE node_id = $1`.
- `getNeighbors(id)`: node + all edges with `from_node_id = id OR to_node_id = id` + the adjacent nodes.
- **No embeddings**: the `vector` column and `@electric-sql/pglite/vector` extension are not loaded.
  The DDL leaves room to add them in the embedding slice without a node/edge schema change.

**New dependency:** `@electric-sql/pglite` added to `governance/package.json` `dependencies`. PGlite is
pure-JS/WASM (no native build, no server) — fits the Node-24 strip-types + vitest sidecar. `:memory:`
in tests means zero on-disk artifacts.

---

## 5. Tests (TDD — written first, per task)

| test file | proves |
| --- | --- |
| `test/graph/project.test.ts` | known event fixtures → expected `nodes`/`edges`; subject derivation per type; each edge type; dangling-ref handling. Pure, no DB. |
| `test/graph/checksum.test.ts` | stable + input-order-independent for the same logical set; changes when any row changes. |
| `test/graph/store.test.ts` (PGlite `:memory:`) | open→rebuild→`getNode`/`getNeighbors` correct; **rebuild twice → identical `status().checksum`** (idempotent); drop-all-rows → rebuild → byte-identical. |
| `test/graph/rebuild-equivalence.test.ts` | `store.status().checksum === checksumProjection(projectGraph(events))` (DB == markdown-derived projection; the §6 "checksum match"). |
| `test/graph/negative.test.ts` | running ingest writes **zero** files under `workspace/events/` and emits **no** events (INVARIANT #1); `projectGraph` performs no I/O. |

Existing suite (371) must stay green; new tests add to it.

---

## 6. MCP surface (4 tools, mirror the `harvest` block)

| tool | inputSchema | behavior |
| --- | --- | --- |
| `rebuild_index` | `{}` | `rebuildIndex(WORKSPACE, store)` → `"index rebuilt: E events, N nodes, G edges (checksum <8hex>)"`. Idempotent: re-run → same checksum. |
| `index_status` | `{}` | `store.status()` → counts + checksum (`"not built"` if empty). |
| `graph_node` | `{ id: string }` | `getNode(id)` → node JSON or `"unknown node: <id>"`. |
| `graph_neighbors` | `{ id: string }` | `getNeighbors(id)` → node + edges + adjacent nodes, or unknown. |

The MCP server opens **one** store at startup (`workspace/index/pglite/`). All four tools are
read/rebuild only — no `approve`/`choose`/`decision_*` surface (master §4.5: approval endpoints are not
exposed on the agent MCP stdio; these aren't approval endpoints at all).

---

## 7. Observable done-criteria (evidence, not prose)

1. `rebuild_index` over the real workspace events → counts; **run twice → identical checksum** (idempotent, mirrors harvest run1→run2=0).
2. `index_status` checksum **===** pure `projectGraph(readAllEvents())` checksum (every derived row reconstructable from events alone).
3. Drop all derived rows (`TRUNCATE`) → `rebuild_index` → **byte-identical checksum** (markdown is canonical).
4. `graph_node <id>` and `graph_neighbors <id>` return the correct node + 1-hop adjacency for a seeded subject.
5. Ingest writes **0** L0 events / files (negative test); `projectGraph` is pure (no I/O) — INVARIANT #1.
6. `pnpm exec vitest run` green (371 + new); `git diff -- src/bindings.ts` **empty** (INVARIANT #4); app SQLite + migrations untouched (#6).

---

## 8. Risks → mitigation

1. **Projection authority leak** (projector emits events / mints verdict) — highest. → `projectGraph`
   pure/total/no-I/O/no-emit; negative test; the store only persists, never writes L0.
2. **SQL drift from TS folds** (②) — avoided by construction: nodes come from the reused folds, not SQL.
3. **PGlite as a hidden second SSOT** — every row carries `source_event_id`/`content_hash`; rebuild-
   equivalence test asserts DB == markdown-derived projection; data dir gitignored as derived cache.
4. **Dangling refs silently dropped** — §3.4 keeps unresolved refs as explicit `refs` edges; never silent.
5. **Dep bloat / native-build friction** — PGlite is pure WASM (no native toolchain); single dep; tests `:memory:`.
6. **bindings.ts drift** — MCP is stdio; assert `git diff` empty in done-criteria.

---

## 9. Provenance / open items

- Scope settled this session via 3 user decisions (§0.1): PGlite runtime · events+nodes+edges only ·
  rebuild+status+thin-read surface. Grounded by reading the as-built `event/event.ts`, `harvest.ts`,
  `event/id.ts`, `orchestrator/view.ts`, the per-axis projectors, `decision/readEvents.ts`, and the MCP
  `harvest` registration block.
- **Deferred to later slices (not this plan):** embeddings/pgvector (corpus-driven) · `approvals` +
  `session_observations` tables · incremental upsert · real Postgres-server stand-up + keyring creds ·
  richer graph queries (paths, typed subgraph) · Control Room UI consumer (Phase H).
- **Forks resolved here** (master §16 "Postgres ingest trigger mechanism"): trigger = **on-demand
  `rebuild_index` MCP command** (no polling loop; INVARIANT #5), mirroring `harvest`.
