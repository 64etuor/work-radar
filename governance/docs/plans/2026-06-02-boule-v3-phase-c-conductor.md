# Boule v3 Phase C — Conductor Implementation Plan

> **Status:** ✅ DONE (2026-06-02) — opus critic round-2 ACCEPT (0B/0M/1 minor-hardened), vitest 301, tsc 0, role-gate headless-proven, drift governance-only, bindings unchanged, NOT pushed. Live cmux smoke = user-run ([runbook](2026-06-02-boule-v3-phase-c-live-smoke-runbook.md)). Spec: [design §7 Phase Ledger](../design/2026-06-02-boule-v3-orchestrator-control-plane-design.md) (per-phase 설계 §7로 흡수 2026-06-04; 원본은 git 히스토리). Headless-first (stub adapter) + real cmux adapter behind `BOULE_CONDUCTOR_MODE=live`.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkboxes = build tracking; the runtime ConductorState = events→derived is the truth. Tick only on real evidence.

**Goal:** A dispatcher (`conduct_plan`) that advances a human-accepted plan one step per call — mint task + spawn one isolated cmux session bound to the step, observe `task_completed`/`decision_blocked`, advance the pointer — with ZERO `decision_*` write-path and ZERO approve capability (structural).

**Architecture:** mirror `src/plan/` + `src/task/`; `deriveConductorState` = composing projection over `step_bound`/`session_spawned` + delegated plan/task folds; DI `ConductorAdapter` (stub default, live cmux behind env). Non-determinism injected at `server.ts` boundary. No Postgres/UI/bindings.

**Tech:** TS (Node 24 strip-types; src `.ts`, tests `.js`), vitest, zod 4.4.3.

---

## Tasks

### [x] US-001 — Events + escalate binding
`src/event/event.ts`: add `step_bound`, `session_spawned` (actor=conductor, verdict-free, provenance comments). `src/escalate/escalate.ts`: add optional `relatedTaskId` to `EscalateInput`; when present, append it to the `decision_blocked` `related_to` (alongside decisionId). Backward-compatible.
**Observable:** tsc resolves; existing escalate tests still green; a new escalate test asserts `relatedTaskId` lands in `related_to`.

### [x] US-002 — `deriveConductorState` projection + step parse
`src/conductor/conductor.ts`: parse plan body numbered steps (`/^\d+\.\s/`); `deriveConductorState(plan, allEvents)` composing `derivePlanState`/`deriveTaskState`/`hasOpenBlock`; cursor + halt + done rules (§4). Pure, no I/O.
**Observable:** `test/conductor/conductor.test.ts` — step parse; planActive precondition; cursor=first-unmaterialized-all-prior-done; halt when open block; done when all terminal; ignores foreign event types; KEYSTONE wipe-stable.

### [x] US-003 — Envelope
`src/conductor/envelope.ts`: `AutonomyEnvelope` type + `buildEnvelope(...)` + canonical JSON + `envelopeHash` (reuse `sha256hex`).
**Observable:** `test/conductor/envelope.test.ts` — deterministic hash; canonical-JSON stable field order; required fields present.

### [x] US-004 — Guards
`src/conductor/guards.ts`: `canAdvance(state)` — refuse if `planPhase!=="active"` / `halted` / `done` / `cursor===null` (in-flight); ok else. Pure.
**Observable:** `test/conductor/guards.test.ts` — each refusal reason + ok path.

### [x] US-005 — Adapter (stub + live factory)
`src/conductor/adapter.ts`: `ConductorAdapter` interface; `stubAdapter` (deterministic, touches no git/cmux/fs); `makeLiveAdapter({spawn, repoRoot, worktreesRoot, cmuxCmd})` (real `git worktree add --detach` + `cmux new-workspace --cwd` capture surface + `cmux send` claude prompt; bounded, surfaced failure — mirror liveReviewer DI).
**Observable:** `test/conductor/` uses stub; live factory unit-tested with an injected fake `spawn` asserting the git+cmux command sequence (no real processes).

### [x] US-006 — Handlers
`src/conductor/handlers.ts`: `conductPlan(workspaceDir, {planId}, deps)` advances ≤1 step (mint `task_created`+`step_bound`, `createWorktree`, `buildEnvelope`+`writeEnvelopeFile`, `spawnSession`, mint `session_spawned`+`task_started`; distinct event ids via per-event second-offset stamps). `conductorStatus(...)` read-only render. **Imports NO `decision/handlers.ts`.**
**Observable:** `test/conductor/handlers.test.ts` (stub) — refuse unaccepted plan; one-step-per-call event delta; observe→advance after task_completed; halt-on-block advances nothing + stays halted; unblock advances.

### [x] US-007 — Negative isolation
`test/conductor/negative.test.ts`: a full conduct run emits only `task_*`/`step_bound`/`session_spawned` — ZERO `decision_*`; grep-assert `src/conductor/**` contains no decision-write import; complete-coupling (`completeTask` refused while step block open).
**Observable:** test green.

### [x] US-008 — MCP wiring + gitignore + gates
`src/mcp/config.ts`: `BOULE_CONDUCTOR_MODE`/`_CMUX_CMD`/`_WORKTREES_ROOT` parsers (safe defaults). `src/mcp/server.ts`: build adapter (stub unless live) + register `conduct_plan`/`conductor_status`. `.gitignore`: `.boule-worktrees/`.
**Observable:** `pnpm exec vitest run` green; `pnpm exec tsc --noEmit` 0; headless stdio `tools/list` shows both tools + a `conduct_plan` stub round-trip; drift `governance/**`+docs only; `bindings.ts` unchanged.

---

## Verification
- `cd governance && pnpm exec vitest run` · `pnpm exec tsc --noEmit`
- `git status --porcelain` → only `governance/**` (+ this plan/spec)
- Live cmux smoke = user-run (design §11).
