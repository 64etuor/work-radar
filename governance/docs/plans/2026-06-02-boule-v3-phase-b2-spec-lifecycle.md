# Boule v3 Phase B2 — Spec Lifecycle Implementation Plan

> **Status:** ✅ DONE (2026-06-02) — opus critic ACCEPT (0B/0M/2 minors, minor#1 symmetric-assertion fixed), vitest 263, tsc 0, drift governance-only, bindings unchanged, NOT pushed. Spec: [design §7 Phase Ledger](../design/2026-06-02-boule-v3-orchestrator-control-plane-design.md) (per-phase 설계 §7로 흡수 2026-06-04; 원본은 git 히스토리). Mirrors the Phase B Plan slice.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkboxes = human/build tracking; the runtime Spec state machine = events → derived state is the orchestrator's truth. Tick only when the named evidence is real.

**Goal:** Make a Spec a first-class, event-sourced object (`draft → accepted → archived`) derived purely from L0 events, with human-gated acceptance. Spec content stays in markdown; events record only lifecycle.

**Architecture:** Mirror `src/plan/` (itself a mirror of `src/task/`). Append-only events `spec_proposed`/`spec_accepted`/`spec_archived`; `deriveSpecState` pure fold; guards = refusal functions; pure projector → `state/specs.json`. No Postgres, no UI, no plan linkage. MCP stdio → no `bindings.ts` change.

**Tech Stack:** TypeScript (Node 24 `--experimental-strip-types`; src imports `.ts`, test imports `.js`), vitest, gray-matter.

---

## File Structure

New `governance/src/spec/` (mirrors `src/plan/`):
- `spec.ts` — `deriveSpecState` + `SpecState`/`SpecPhase` + `specsOf`.
- `guards.ts` — `canAccept` (draft→accepted), `canArchive` (non-terminal→archived).
- `handlers.ts` — `proposeSpec` (propose-only, `actor:"author"`) + `acceptSpec`/`archiveSpec` (human-gated `actor:"user"`) + `listSpecs`/`specTrail`.
- `project.ts` — pure `projectSpecs` + `renderSpecs` → `state/specs.json`.

Modified: `src/event/event.ts` (+3 `spec_*` types), `src/mcp/server.ts` (+5 tools).
Tests: `test/spec/{spec,guards,handlers,project}.test.ts`.

---

## Tasks

### [x] US-001 — Spec event types
`src/event/event.ts`: add `spec_proposed`/`spec_accepted`/`spec_archived` with provenance comments.
**Observable:** `tsc` resolves the union.

### [x] US-002 — `deriveSpecState` fold + `specsOf`
`src/spec/spec.ts`. Precedence `archived` (terminal) > `accepted` > `draft`. God-fold type filter.
**Observable:** `test/spec/spec.test.ts` green — draft, accept→accepted, archive→archived terminal, archive precedence over accepted, `specsOf` filter, ignores foreign types.

### [x] US-003 — Guards
`src/spec/guards.ts`. `canAccept` (draft only), `canArchive` (any non-terminal).
**Observable:** `test/spec/guards.test.ts` green for ok/refuse per phase.

### [x] US-004 — Author + lifecycle handlers
`src/spec/handlers.ts`. `proposeSpec` writes one `spec_proposed` `actor:"author"`, validates non-empty title. `acceptSpec`/`archiveSpec` hard-code `actor:"user"`.
**Observable:** `test/spec/handlers.test.ts` green — propose writes exactly one `spec_proposed` (actor author, not user); throws on empty title; accept writes `spec_accepted` actor user; **structural:** propose path writes no `spec_accepted`; accept refused when not draft; `listSpecs` omits archived; `specTrail` chain. **NEGATIVE:** zero `decision_*`/`task_*`/`plan_*`.

### [x] US-005 — Projector + KEYSTONE
`src/spec/project.ts`. `projectSpecs` pure; `renderSpecs` → `state/specs.json`.
**Observable:** `test/spec/project.test.ts` green — pure/no-I/O; **KEYSTONE** wipe `state/` → re-render byte-identical; reflects derived phases.

### [x] US-006 — MCP registration
`src/mcp/server.ts` +5 tools mirroring plan registrations. `propose_spec` agent-visible; rest human/bridge.
**Observable:** `tsc` 0; full suite green; `bindings.ts` drift 0.

### [x] US-007 — Gate verification
**Observable:** `pnpm exec vitest run` all green (242 Phase B baseline + new spec tests); `pnpm exec tsc --noEmit` 0; drift `governance/**`+docs only.

---

## Verification commands
- `cd governance && pnpm exec vitest run`
- `cd governance && pnpm exec tsc --noEmit`
- `git status --porcelain` → only `governance/**` (+ this plan/spec).
