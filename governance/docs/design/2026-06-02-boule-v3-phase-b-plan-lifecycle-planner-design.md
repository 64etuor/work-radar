# Boule v3 Phase B — Plan Lifecycle Event-Sourcing + Planner (Design)

> **Status:** DRAFT (2026-06-02) — branch `feat/boule-v2-planner`. Depends on Phase A (Task lifecycle SSOT, DONE `f4e7a3c..83aa965`). Master: [v3 Orchestrator Control Plane](2026-06-02-boule-v3-orchestrator-control-plane-design.md) §8/§10/§11. Precedent: [v2 HITL Plan→Loop](2026-06-01-ssot-governance-harness-hitl-plan-loop-design.md) §Planner.

## 1. Problem

The master Phase sequence (§10) puts **Phase B = "Spec/Plan event-sourcing + Planner (intent→`plan_proposed`)"** on the critical path, with the substrate (Phase A Task lifecycle) already BUILT. Today a **Plan** is not a first-class governance object: there is no append-only event type for it, no derived state machine, no propose-only Planner. The "1 intent → 1 draft plan, plan acceptance = human gate" loop (master §10 Phase-B Done) has nowhere to live.

## 2. Goal (this slice)

Make a **Plan** a first-class, event-sourced execution-plane object whose lifecycle state is a **pure fold over L0 events** — exactly mirroring the proven `src/task/` module — plus a **Planner** command that turns an intent into **exactly one `plan_proposed` (draft)** and **cannot accept its own plan** (acceptance is a hard-coded human gate).

**Observable Done-criteria (evidence, not prose):**

1. `propose_plan(intent, steps[])` → **exactly one** immutable `plan_proposed` event in draft phase; its `actor` is the Planner (`"planner"`), **never `"user"`**.
2. `accept_plan` writes `plan_accepted` with **`actor:"user"`** (human gate) and moves `draft → active`. There is **no code path** by which `propose_plan` writes a `plan_accepted` (structural INVARIANT #1: the proposer cannot self-accept).
3. `state/` wipe → `renderPlans` re-run → projection **byte-identical** (derived-not-authored proof).
4. Plan commands write **no `decision_*` and no `task_*` events** (negative isolation test).
5. vitest green; no Postgres; **`bindings.ts` unchanged** (MCP is stdio → INVARIANT #4 N/A).

## 3. Scope boundary (what this slice is NOT)

Bounded to **Plan + Planner**, mirroring Phase A's single-fold scope. Explicitly **deferred** (each = its own later spec+plan+critic, per master §10):

- **Spec lifecycle** (`spec_proposed`/`spec_accepted`/`spec_archived`) — Phase B2. (Done-criterion §10 names only the plan round-trip; a plan need not reference a spec object yet.)
- **`plan_drift_detected`** + drift heuristics (§8: completed-task-unreflected / out-of-plan work / stalled step / spec-scope-exit / oversized-task) — drift is a richer observe-only concern; deferred.
- **Conductor** (Phase C: cmux 1-step spawn that advances plans) and autonomy envelope. This slice has **no agent-driven plan advancement** — every non-propose transition is human-gated (`actor:"user"`).
- Postgres/pgvector (Phase F), Control Room UI (Phase H).

## 4. State machine (master §8)

`PlanPhase = draft | active | needs_revision | completed | archived | superseded`

```
plan_proposed ─▶ draft ──accept(user)──▶ active ──revise──▶ needs_revision
                                            │                    │
                                            │                    └──accept(user)──▶ active
                                            ├──complete──▶ completed   (terminal)
                                            ├──archive───▶ archived    (terminal)
                                            └──supersede─▶ superseded  (terminal)
```

`plan_proposed` is the **creating event** (the plan id = its event id); all lifecycle events `related_to` the plan id. The resting phase before the human gate = `draft` (= "proposed, awaiting acceptance"; v2 design line 62 "emits exactly one `plan_proposed` (draft)").

**Fold precedence** (mirrors `deriveTaskState` cancelled > done): terminal markers first —
`archived > superseded > completed` — else the **latest** of `{plan_accepted → active, plan_revised → needs_revision}` by chronological id; none → `draft`. (god-fold ban §8: `derivePlanState` ignores every event type it does not own — fail-closed type filter, same discipline as `decision.ts`/`task.ts`.)

## 5. Module layout (mirror `src/task/`)

New `governance/src/plan/`:

- `plan.ts` — `derivePlanState(created, related)` pure fold + `PlanState`/`PlanPhase` + `plansOf(all)` helper (clone of `task.ts`).
- `guards.ts` — refusal functions (clone of `task/guards.ts`):
  - `canAccept` — ok from `draft`/`needs_revision`; refuse terminal/active.
  - `canRevise` — ok only from `active`.
  - `canComplete` — ok only from `active`.
  - `canArchive` / `canSupersede` — ok at any non-terminal (mirror `canCancel`).
- `handlers.ts` —
  - **Planner** `proposePlan(dir, {intent, steps[]}, now, rand)` → one `plan_proposed`, `actor:"planner"`, `source:"hermes"`, `tags:["plan"]`; body = intent (title line) + numbered steps. Validates non-empty intent and ≥1 non-empty step (throws otherwise). **No accept/verdict write-path.**
  - Lifecycle writers (clone `task/handlers.ts writeLifecycle`, hard-coded `actor:"user"`): `acceptPlan`, `revisePlan(reason)`, `completePlan`, `archivePlan`, `supersedePlan`. Each loads state, applies its guard, writes one event or returns `{ok:false, reason}`.
  - Readers `listPlans` (non-terminal) / `planTrail`.
- `project.ts` — pure `projectPlans(events)` + `renderPlans(dir)` → `state/plans.json` (already gitignored via `workspace/state/*.json`). Sole writer of plan status.

Modified: `src/event/event.ts` (+6 `plan_*` types), `src/mcp/server.ts` (+8 tools: `propose_plan`/`accept_plan`/`revise_plan`/`complete_plan`/`archive_plan`/`supersede_plan`/`plans`/`plan`).

Reused unchanged: `event/{id,writeEvent}.ts`, `decision/readEvents.ts` (`readAllEvents`, `eventsForDecision`).

## 6. INVARIANT mapping (decision-rails)

- **#1 (no automation on the decision rail):** structural. `proposePlan` writes only `plan_proposed`; `plan_accepted` is written exclusively by `acceptPlan` with `actor:"user"` hard-coded. The Planner agent literally has no tool that mints an acceptance. Negative tests assert (a) no `plan_proposed` has `actor:"user"`, (b) no `plan_accepted` has `actor:"planner"`, (c) plan commands emit zero `decision_*`/`task_*`.
- **#4 (tauri-specta bindings):** MCP stdio only → no `bindings.ts` change.
- **#5 (bounded, no infinite poll):** no timers/polling; all transitions are single on-demand writes.
- **#6 (SQLite migrations only):** no DB touched.
- **#7 (visual design SSOT):** no UI.
- **#2/#3 (keychain / network in Rust):** N/A — pure local file events, no network, no tokens.

## 7. Risks

- **Planner-as-decider via plan ordering** (v2 §risk 111): a plan that implicitly forecloses options is automation through the back door. Mitigation (this slice): the plan is **draft until a human `accept_plan`**; nothing downstream consumes a draft. Conductor consumption + no-auto-default lands in Phase C on a proven loop.
- **Filename collision:** `writeEvent` uses `wx` on `HH-MM-SS_<type>.md`; two `plan_proposed` in the same UTC second collide (throws). Acceptable — same constraint as Phase A; tests use distinct seconds.
