# Boule v3 Phase D — Session Registry + cmux Observer Implementation Plan

> **Status:** ✅ DONE (2026-06-03) — opus critic separate-pass ACCEPT (0 blockers / 0 MAJOR / 2 MINOR; MINOR #1 hardened in `negative.test.ts`). tsc 0, vitest **353** (49 in test/session/), headless stdio smoke OK (11 Phase-D tools + stub no-op), drift `governance/**` only, `bindings.ts` unchanged. NOT pushed (PARKED). **Live cmux smoke (AI-run 2026-06-03): reconcile LOGIC 7/7 GREEN vs REAL cmux surfaces** — known session→`session_observed`(active), exactly one across two observes (heartbeat-on-change), unmanaged surface→one `session_opened` external_owned + idempotent, removed surface→`session_crashed`. ~~⚠️ **BLOCKER (live adapter only): `makeLiveAdapter` runs `cmux list` which real cmux LACKS (status 1 → throws)**~~ **[RESOLVED 2026-06-03]** live adapter now runs `cmux tree --all --json` (terminal-only surface walk) — see plan `2026-06-03-boule-v3-phase-d-observer-live-adapter-fix.md`; reconcile logic unchanged. Design: [session-registry-design](../design/2026-06-03-boule-v3-phase-d-session-registry-design.md).

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkboxes = build tracking; the runtime `SessionState = events→derived` is the truth. Tick only on real evidence.

**Goal:** A read-only, on-demand registry projecting the master-§8 session lifecycle from events, plus a cmux Observer that reconciles live surfaces against the registry (observe / crash / recover / orphan-open) with ZERO `decision_*` write-path and ZERO auto-close (structural).

**Architecture:** mirror `src/task/` (fold + guards + projector + handlers) and `src/conductor/` (DI adapter, stub default + live behind env). `deriveSessionState` = pure fold over `session_*` lifecycle events; sessionId = birth-event id; observer emits only on state-change. Non-determinism injected at `server.ts`. No Postgres/UI/bindings.

**Tech:** TS (Node 24 strip-types; src `.ts`, tests `.js`), vitest, zod 4.4.3.

Design: [2026-06-03-boule-v3-phase-d-session-registry-design.md](../design/2026-06-03-boule-v3-phase-d-session-registry-design.md).

---

## Tasks

### [x] US-001 — Event types

`src/event/event.ts`: add the 12 `session_*` types from design §2 to the `EventType` union (verdict-free, provenance comments mirroring the task/plan block). Confirm `system` ∈ `EventSource` (it is) — no source change needed.
**Observable:** `pnpm exec tsc --noEmit` resolves; existing tests still green; grep shows all 12 types present.

### [x] US-002 — `deriveSessionState` fold + `sessionsOf`

`src/session/session.ts`: `SessionPhase`, `Ownership`, `SessionState`; `deriveSessionState(birth, related)` per design §4 (precedence: closed > crash/recover-latest > active-substate-latest-by-id > birth phase); surface/ownership parsed from birth body JSON (spawned→orchestrator_owned; opened/open_requested→body `.ownership`||user_owned); `sessionsOf(all)` = origin events whose `related_to` contains no other origin id (design §3 disambiguation).
**Observable:** `test/session/session.test.ts` — spawned birth → opening/orchestrator_owned/surface; opened birth → opening/user_owned; open_requested → planned; observe→active; waiting/blocked/pressure(high)/checkpoint/handoff substates by latest id; close→closed terminal-wins; crash then recover by latest; pressure level low/medium inert for phase; foreign event types ignored (god-fold); `sessionsOf` excludes the `session_opened` transition that references an origin.

### [x] US-003 — Guards

`src/session/guards.ts`: `SessionGate {ok,reason}`; `canObserve`, `canRecover` (crashed only), `canWait`/`canBlock`/`canHandoffReady`/`canPressure`/`canCheckpoint` (refuse terminal; pressure/checkpoint also refuse crashed), `canRequestClose` (refuse terminal), `canClose` (phase===`closing` only). Pure.
**Observable:** `test/session/guards.test.ts` — each refusal reason + ok path; `canClose` refuses unless `closing`; `canRecover` refuses unless `crashed`.

### [x] US-004 — Projector + keystone

`src/session/project.ts`: `projectSessions(all)` pure (sorted by sessionId, delegates to `deriveSessionState`); `renderSessions(workspaceDir)` → `state/sessions.json` (byte-stable rows `{sessionId, surface, ownership, taskId, phase}`, sole status writer, `GENERATED` semantics via gitignore).
**Observable:** `test/session/project.test.ts` — KEYSTONE: `renderSessions` byte-identical after `state/` wipe + rebuild over a random valid session event sequence; `projectSessions` emits no events / no I/O.

### [x] US-005 — Record + read handlers

`src/session/handlers.ts`: `loadSession` (birth via `eventsForDecision`, reject non-origin); `writeLifecycle` (one event, `related_to:[sessionId]`, `source:"system"`, `actor:"user"`); `markWaiting`/`markBlocked`/`recordPressure`/`requestCheckpoint`/`markHandoffReady`/`requestSessionOpen`(births planned)/`requestSessionClose`/`closeSession` (each guarded); `listSessions` (non-terminal, clone of `listTasks`); `sessionTrail` (clone of `taskTrail`). **Imports NO `decision/handlers.ts`.**
**Observable:** `test/session/handlers.test.ts` — `requestSessionOpen` births a planned session listed by `sessions`; guarded transitions refuse per state (e.g. `closeSession` refused unless close-requested); `sessionTrail` shows full chain; one event per call.

### [x] US-006 — Observer (adapter seam + reconcile)

`src/session/observer.ts`: `LiveSurface`, `ObserverAdapter.listSurfaces()`; `stubAdapter` (deterministic injected list, no cmux); `makeLiveAdapter({spawn, cmuxCmd})` (real `cmux list`, bounded one-shot, surfaced failure, parse surfaces from stdout — mirror `makeLiveAdapter` in conductor). `observeSessions(workspaceDir, {adapter}, now, rand)` reconciles per design §5 table, emitting ≤1 transition per session via the existing `writeEvent` (distinct ids via per-session second-offset stamps). Returns a summary `{observed, crashed, recovered, opened}`. **NO `session_closed` write anywhere in this file.**
**Observable:** `test/session/observer.test.ts` (stub) — alive opening→`session_observed`(once across two passes); gone active→`session_crashed`; back→`session_recovered`; unknown surface→one `session_opened`(external_owned), idempotent re-observe; live factory unit-tested with injected fake `spawn` asserting the `cmux list` command + surface parse (no real process).

### [x] US-007 — Negative isolation + no-auto-close

`test/session/negative.test.ts`: a full observe + record run emits only `session_*` — ZERO `decision_*`; grep-assert `src/session/**` contains no decision-write import AND no `session_closed` literal in `observer.ts`; assert no reconcile branch (gone/crashed/closed) ever yields `session_closed`; `close_session` is the ONLY path to `session_closed` and only after `session_close_requested`.
**Observable:** test green.

### [x] US-008 — MCP wiring + config + gates

`src/mcp/config.ts`: `parseObserverConfig(env)` (`BOULE_OBSERVER_MODE`/`_CMUX_CMD`, safe defaults). `src/mcp/server.ts`: build observer adapter (stub unless live) + register `sessions`/`session`/`observe_sessions` + the 8 record commands (all verdict-free — none gated by `SESSION_ALLOWS_VERDICTS`). Non-determinism (`nowFn`/`randFn`/spawn) at the boundary.
**Observable:** `pnpm exec vitest run` green; `pnpm exec tsc --noEmit` 0; headless stdio `tools/list` shows the new tools + an `observe_sessions` stub round-trip; `git status --porcelain` → only `governance/**` (+ this plan/design); `bindings.ts` unchanged.

---

## Verification

- `cd governance && pnpm exec vitest run` · `pnpm exec tsc --noEmit`
- `git -C <repo> status --porcelain` → only `governance/**` (+ plan/design)
- Separate critic pass (opus) for INVARIANT #1/#4/#5/#6 — self-approve forbidden.
- Live cmux smoke = user-run (design §11).
- Commit per-task (Conventional Commits); **never push** (PARKED).
