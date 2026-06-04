# Boule v3 Phase B — Plan Lifecycle + Planner Implementation Plan

> **Status:** ✅ DONE (2026-06-02) — branch `feat/boule-v2-planner`, opus critic ACCEPT (0 blockers/0 majors/3 inherited minors), vitest 242, tsc 0, drift `governance/**`-only, `bindings.ts` unchanged. Spec: [design](../design/2026-06-02-boule-v3-phase-b-plan-lifecycle-planner-design.md). Mirrors the proven Phase A plan format. NOT pushed (push = explicit user request only).

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes for human/build tracking; the **runtime Plan state machine = events → derived state** is the orchestrator's truth, never these checkboxes. Tick a box only when its named Orchestrator-observable evidence is real (test green / event written).

**Goal:** Make a Plan a first-class, event-sourced execution-plane object with a lifecycle derived purely from L0 events, plus a propose-only Planner (intent → exactly one `plan_proposed` draft) that cannot accept its own plan.

**Architecture:** Mirror `src/task/` exactly. Append-only L0 events (`plan_proposed`/`plan_accepted`/`plan_revised`/`plan_completed`/`plan_archived`/`plan_superseded`); `derivePlanState` = pure fold; guards = refusal functions; pure projector renders `state/plans.json`. No Postgres, no UI, no Conductor. MCP stdio only → no `bindings.ts` change.

**Tech Stack:** TypeScript (Node 24 `--experimental-strip-types`, runtime src imports `.ts`, test imports `.js`), vitest, gray-matter. Same toolchain as `src/task/`.

---

## File Structure

New module `governance/src/plan/` (mirrors `src/task/`):

- `src/plan/plan.ts` — `derivePlanState` pure fold + `PlanState`/`PlanPhase` + `plansOf`.
- `src/plan/guards.ts` — `canAccept`/`canRevise`/`canComplete`/`canArchive`/`canSupersede`.
- `src/plan/handlers.ts` — Planner `proposePlan` (propose-only) + `acceptPlan`/`revisePlan`/`completePlan`/`archivePlan`/`supersedePlan` (human-gated `actor:"user"`) + `listPlans`/`planTrail`.
- `src/plan/project.ts` — pure `projectPlans` + `renderPlans` → `state/plans.json`.

Modified: `src/event/event.ts` (+6 `plan_*` types), `src/mcp/server.ts` (+8 tools).

Reused unchanged: `decision/readEvents.ts`, `event/{id,writeEvent}.ts`.

Tests (mirror `test/task/`): `test/plan/{plan,guards,handlers,project}.test.ts`.

---

## Tasks

### [x] US-001 — Plan event types
Add 6 `plan_*` types to the `EventType` union in `src/event/event.ts` with one-line provenance comments.
**Orchestrator-observable:** `tsc` resolves the union; downstream modules compile.

### [x] US-002 — `derivePlanState` pure fold + `plansOf`
`src/plan/plan.ts` clone of `task.ts`. Precedence `archived > superseded > completed`, else latest of accepted/revised → active/needs_revision, else draft.
**Orchestrator-observable:** `test/plan/plan.test.ts` green — draft, accept→active, revise→needs_revision, re-accept→active, completed terminal, archived precedence, superseded terminal, `plansOf` filter.

### [x] US-003 — Guards (refusal functions)
`src/plan/guards.ts`. `canAccept` (draft/needs_revision), `canRevise`/`canComplete` (active only), `canArchive`/`canSupersede` (any non-terminal).
**Orchestrator-observable:** `test/plan/guards.test.ts` green for ok/refuse on each phase.

### [x] US-004 — Planner + lifecycle handlers
`src/plan/handlers.ts`. `proposePlan` writes one `plan_proposed` `actor:"planner"`, validates intent/steps. Lifecycle writers hard-code `actor:"user"`.
**Orchestrator-observable:** `test/plan/handlers.test.ts` green — propose writes exactly one `plan_proposed` (actor planner, not user); propose throws on empty intent/steps; accept writes `plan_accepted` actor user; **structural:** propose path writes no `plan_accepted`; gates refuse from wrong phases; `listPlans` omits terminal; `planTrail` chain. **NEGATIVE:** plan commands write zero `decision_*`/`task_*`.

### [x] US-005 — Projector + KEYSTONE
`src/plan/project.ts`. `projectPlans` pure; `renderPlans` → `state/plans.json`.
**Orchestrator-observable:** `test/plan/project.test.ts` green — pure/no-I/O; **KEYSTONE** wipe `state/` → re-render byte-identical; projection reflects derived phases.

### [x] US-006 — MCP registration
`src/mcp/server.ts` +8 tools mirroring task registrations. `propose_plan` agent-visible; rest human/bridge.
**Orchestrator-observable:** `tsc` 0; full suite green; `bindings.ts` drift 0 (stdio).

### [x] US-007 — Gate verification
**Orchestrator-observable:** `pnpm exec vitest run` all green (Phase A 214 baseline + new plan tests); `pnpm exec tsc --noEmit` 0; `git status` shows drift only under `governance/**` + docs.

---

## Verification commands

- `cd governance && pnpm exec vitest run`
- `cd governance && pnpm exec tsc --noEmit`
- Drift check: `git status --porcelain` → only `governance/**` (+ this plan/spec).
