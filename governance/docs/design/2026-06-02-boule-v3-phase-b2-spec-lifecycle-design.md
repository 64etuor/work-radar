# Boule v3 Phase B2 — Spec Lifecycle Event-Sourcing (Design)

> **Status:** DRAFT (2026-06-02) — branch `feat/boule-v2-planner`, on top of Phase B (Plan lifecycle + Planner, `40ab6eb`). Completes the "**Spec**/Plan event-sourcing" half of master Phase B (§10 row B). Master: [v3 Orchestrator Control Plane](2026-06-02-boule-v3-orchestrator-control-plane-design.md) §10/§11 (§11: `spec_proposed`·`spec_accepted`·`spec_archived`; §101: "Spec의 _lifecycle_만 이벤트" — content stays in markdown). Sibling precedent: [Phase B Plan slice](2026-06-02-boule-v3-phase-b-plan-lifecycle-planner-design.md).

## 1. Problem

Phase B's table row is "Spec/Plan event-sourcing + Planner". The Plan half shipped (`40ab6eb`); the **Spec** half was deferred as "Phase B2". A Spec is not yet a first-class governance object: no append-only lifecycle event, no derived state, no human-gated acceptance. Plans will eventually `related_to` an accepted spec; that anchor does not exist.

## 2. Goal (this slice)

Make a **Spec** a first-class, event-sourced object whose lifecycle (`draft → accepted → archived`) is a **pure fold over L0 events**, mirroring the proven `src/plan/` and `src/task/` modules. Spec **content lives in markdown** (per §101); the events record only the lifecycle. Acceptance is a **hard-coded human gate** (`actor:"user"`); the author/agent that proposed a spec cannot accept it.

**Observable Done-criteria (evidence):**

1. `propose_spec(title, summary)` → exactly one immutable `spec_proposed` (draft), `actor:"author"` (never `"user"`).
2. `accept_spec` writes `spec_accepted` with `actor:"user"` (human gate), `draft → accepted`. No code path lets the proposer mint `spec_accepted` (structural INVARIANT #1).
3. `state/` wipe → `renderSpecs` re-run → byte-identical (KEYSTONE).
4. Spec commands write no `decision_*`, `task_*`, or `plan_*` events (negative isolation).
5. vitest green; no Postgres; `bindings.ts` unchanged (stdio → INVARIANT #4 N/A).

## 3. Scope boundary

Bounded to the 3 designed spec events. Explicitly **deferred**: spec↔plan linkage (a plan `related_to` an accepted spec), spec revision/supersession (`spec_superseded` not in §11), spec-scope-exit drift (§8, a Plan-drift concern), Postgres/UI. No Conductor coupling.

## 4. State machine

`SpecPhase = draft | accepted | archived`

```
spec_proposed ─▶ draft ──accept(user)──▶ accepted ──archive──▶ archived (terminal)
                  └──────────────────────archive──────────────▶ archived (terminal)
```

`spec_proposed` is the creating event (spec id = its event id); lifecycle events `related_to` the spec id. Only `archived` is terminal; `accepted` is a live non-terminal phase (a spec stays accepted until retired).

**Fold precedence** (god-fold ban §8 — `deriveSpecState` ignores types it does not own): `archived` (terminal) first; else `accepted` if any `spec_accepted`; else `draft`.

## 5. Module layout (mirror `src/plan/`)

New `governance/src/spec/`:

- `spec.ts` — `deriveSpecState(created, related)` pure fold + `SpecState`/`SpecPhase` + `specsOf(all)`.
- `guards.ts` — `canAccept` (draft only → accepted), `canArchive` (any non-terminal → archived).
- `handlers.ts` — author `proposeSpec(dir, {title, summary}, now, rand)` → one `spec_proposed`, `actor:"author"`, validates non-empty title; lifecycle writers `acceptSpec`/`archiveSpec` (hard-coded `actor:"user"`); readers `listSpecs` (non-archived) / `specTrail`.
- `project.ts` — pure `projectSpecs` + `renderSpecs` → `state/specs.json` (already gitignored via `workspace/state/*.json`).

Modified: `src/event/event.ts` (+3 `spec_*` types), `src/mcp/server.ts` (+5 tools: `propose_spec`/`accept_spec`/`archive_spec`/`specs`/`spec`).

Reused unchanged: `event/{id,writeEvent}.ts`, `decision/readEvents.ts`.

## 6. INVARIANT mapping

- **#1:** structural — `proposeSpec` writes only `spec_proposed` (`actor:"author"`); `spec_accepted` is written exclusively by `acceptSpec` with `actor:"user"` hard-coded. Negative tests assert no `spec_proposed` has `actor:"user"`, no `spec_accepted` has `actor:"author"`, and spec commands emit zero `decision_*`/`task_*`/`plan_*`.
- **#4:** MCP stdio only → no `bindings.ts` change. **#5:** no timers/polling. **#6:** no DB. **#7:** no UI. **#2/#3:** no network/tokens.

## 7. Risks

- **Spec content drift from the event:** the event records lifecycle, not content (§101). A spec's markdown can change without a new event — acceptable for this slice; content-versioning is a deferred concern. The `summary` in the event body is a denormalized convenience label, not the source of truth.
- **Filename collision:** `writeEvent` `wx` on `HH-MM-SS_<type>.md`; same-second `spec_proposed` collide (throws). Same constraint as Phase A/B; tests use distinct seconds.
