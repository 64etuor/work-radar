# SSOT Governance Harness — Boule v3 Phase D: Session Registry + cmux Observer (design)

- **Date**: 2026-06-03
- **Status**: ✅ IMPLEMENTED (2026-06-03) — opus critic separate-pass ACCEPT (0 blockers). Plan: `governance/docs/plans/2026-06-03-boule-v3-phase-d-session-registry.md`. PARKED branch `feat/boule-v3-phase-d` (commit only, never push without explicit request)
- **Parent**: `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` (master §8 state machines, §10 phase sequence, §11 event taxonomy, §13 INVARIANTs) + Phase C Conductor (`session_spawned` birth source)
- **Depends-on**: Phase C (Conductor) — DONE.

> Working name **Boule** (아테네 평의회).

---

## 0. Goal

A **read-only, on-demand** registry that projects the full master-§8 session lifecycle from events,
plus a **cmux Observer** that two-way-reconciles live surfaces against the registry to drive the
observable transitions and detect orphans. **Verdict-free; no auto-close; no daemon.**

This is the master plan's **Phase D** (§10): "Session Registry + cmux Observer (read-only
heartbeat) — 입력 없이 에이전트 상태 관찰; orphan 감지." It rides the Phase C substrate (the
Conductor already mints `session_spawned`) and is consumed later by Phase E (orchestrator
suggestions) and Phase G (handoff continuity).

---

## 1. Module layout (mirrors `src/task/` + `src/conductor/`)

```
src/session/
  session.ts    # SessionState + deriveSessionState fold (pure; clone of deriveTaskState)
  guards.ts     # transition deny-functions (clone of task/guards.ts)
  project.ts    # projectSessions (pure) + renderSessions → state/sessions.json (sole status writer)
  handlers.ts   # record commands + read commands (I/O; clone of task/handlers.ts)
  observer.ts   # ObserverAdapter DI seam + reconcile (clone of conductor/adapter.ts pattern)
test/session/
  session.test.ts guards.test.ts project.test.ts handlers.test.ts observer.test.ts negative.test.ts
```

No Postgres, no UI, no `bindings.ts` (MCP is stdio → INVARIANT #4 non-target, master §13).

---

## 2. Event types (12, added to `EventType`; all verdict-free)

Per master §11 (session block), added to `src/event/event.ts`:

`session_open_requested`, `session_opened`, `session_observed`, `session_waiting`,
`session_blocked`, `session_context_pressure_changed`, `session_checkpoint_requested`,
`session_handoff_ready`, `session_close_requested`, `session_closed`, `session_crashed`,
`session_recovered`.

`source ∈ system | hermes | agent_run` — none carries verdict authority. (`session_spawned`
already exists from Phase C; `system` is added to `EventSource` if absent.) `agent_run` is
already in `EventSource`; verify `system` membership (it is present).

---

## 3. Domain / identity (resolved seam)

A session's identity is the **id of its birth event** — exactly as `deriveTaskState` uses the
`task_created` event id as the task id. The fold groups lifecycle events with the existing
`eventsForDecision(all, sessionId)` engine (events whose `related_to ∋ sessionId`).

**Birth (origin) events — establish `sessionId = own event id`:**

| Birth event              | Initial phase | Ownership                                     | Surface source                       |
| ------------------------ | ------------- | --------------------------------------------- | ------------------------------------ |
| `session_spawned` (Ph C) | `opening`     | `orchestrator_owned`                          | body JSON `.surface`                 |
| `session_opened`         | `opening`     | body JSON `.ownership` (default `user_owned`) | body JSON `.surface`                 |
| `session_open_requested` | `planned`     | body JSON `.ownership` (default `user_owned`) | body JSON `.surface` (may be absent) |

> **Why `session_open_requested` is also a birth:** master §8 starts the machine at `planned`,
> and the `request_session_open` record command (§6) must produce an _observable_ planned
> session. The master §3 prose names only spawned/opened because it was distinguishing
> ownership; this generalizes it without contradiction.

**Disambiguation (no double-count):** a `session_opened` / `session_open_requested` whose
`related_to` includes an existing birth id is a **transition** (e.g. `planned → opening`), NOT a
new birth. `sessionsOf(all)` therefore enumerates origin events whose `related_to` contains no
other origin id. (Orphan auto-register emits a standalone `session_opened` with no origin
reference → a birth. Phase C `session_spawned.related_to=[taskId]`; `taskId` is not an origin →
birth.)

`ownership ∈ user_owned | orchestrator_owned | external_owned`. `related_to ∋ taskId` carries the
task binding (Phase C spawn); `related_to ∋ sessionId` carries lifecycle.

---

## 4. `deriveSessionState` fold (pure, fail-closed, id-tiebreak — clone of `deriveTaskState`)

```
planned ──open──▶ opening ──observe──▶ active ──▶ { waiting, blocked,
        context_pressure_high, checkpoint_requested } ──▶ handoff_ready
        ──close_requested──▶ closing ──close──▶ closed   (terminal)
active/any-alive ──surface-gone──▶ crashed ──surface-back──▶ recovering
```

`SessionState = { sessionId, surface: string|null, ownership, taskId: string|null, phase, verdict: "closed"|null }`.

**Precedence (clone of task fold):**

1. **terminal `closed` wins** (any `session_closed`) → `phase=closed`, `verdict="closed"`.
2. else if any crash/recover: the **latest** of `session_crashed`/`session_recovered` by id →
   `crashed` / `recovering`.
3. else the **latest active-substate transition by id** among
   `{session_observed→active, session_waiting→waiting, session_blocked→blocked,
session_context_pressure_changed→context_pressure_high, session_checkpoint_requested→checkpoint_requested,
session_handoff_ready→handoff_ready, session_close_requested→closing}`.
4. else the **birth phase** (`planned` for `session_open_requested`, else `opening`).

`session_context_pressure_changed` body JSON `.level ∈ low|medium|high|critical`; only
`high|critical` maps to `context_pressure_high` (low/medium leave the prior substate — modeled as
no substate advance, i.e. the event is recorded but the projector keeps the latest _advancing_
transition; for Phase D simplicity any pressure event with high/critical advances, others are
inert for phase). Fail-closed on foreign event types (god-fold ban, master §8). `checkpointing`
is a §8 sketch state with no Phase-D event → unreachable here (deferred, §12).

---

## 5. Observer (`observer.ts`, read-only, on-demand, DI seam — clone of `ConductorAdapter`)

```ts
export interface LiveSurface {
  surface: string;
}
export interface ObserverAdapter {
  listSurfaces(): Promise<LiveSurface[]>;
}
export const stubAdapter: ObserverAdapter; // deterministic, injected list; touches no cmux
export function makeLiveAdapter(deps): ObserverAdapter; // behind BOULE_OBSERVER_MODE=live → `cmux tree --all --json` (terminal surfaces only)
```

`observe_sessions` reconciles the live surface set against the derived registry and emits **only on
state-change** (no heartbeat flood). Let `alive` = the set of live surfaces, `known` = sessions
indexed by surface.

| Condition                                                    | Emit                                | Phase effect         |
| ------------------------------------------------------------ | ----------------------------------- | -------------------- |
| known session, surface alive, phase ∈ {planned,opening}      | `session_observed`                  | → active             |
| known session, surface alive, phase = crashed                | `session_recovered`                 | crashed → recovering |
| known session, surface alive, phase already alive-observed\* | (nothing — no flood)                | —                    |
| known session, surface gone, phase not terminal/crashed      | `session_crashed`                   | → crashed            |
| known session, surface gone, phase ∈ {crashed,closed}        | (nothing)                           | —                    |
| **live surface bound to no known session**                   | `session_opened` (`external_owned`) | birth → opening      |

\* alive-observed = `{active, waiting, blocked, context_pressure_high, checkpoint_requested, handoff_ready, recovering}`.

- **Orphan auto-open is allowed** (master §18.4) — register once; on re-observe the surface is
  known → no second `session_opened` (idempotent). The next observe transitions opening→active.
- **The observer NEVER emits `session_closed`** (master §18.3 no-auto-close). Structural: the
  observer code path has zero `session_closed` write; negative test asserts it.
- One reconcile pass emits **at most one** transition per session.
- Non-determinism (`cmux tree --all --json` spawn) injected at the `server.ts` boundary, default stub (CI
  touches no cmux), exactly like the Conductor adapter.

---

## 6. Record commands (verdict-free; E/G auto-producers call these later)

Each writes exactly one lifecycle event with `related_to:[sessionId]` (clone of task handlers),
guarded by §8 transition guards:

`mark_session_waiting`, `mark_session_blocked {reason}`, `record_context_pressure {level}`,
`request_checkpoint`, `mark_handoff_ready`, `request_session_open {ownership?, surface?}` (births a
planned session), `request_session_close` (→ `session_close_requested`), `close_session` (→
`session_closed`, **only after** `session_close_requested`).

## 7. Read commands

`sessions` — non-terminal session list (clone of `tasks`). `session <id>` — state + full audit
trail (clone of `task`).

---

## 8. Guards (transition deny-functions, clone of `task/guards.ts`)

- `canObserve` / phase helpers used by the observer (pure; the observer decides emission, the
  guards keep writes legal).
- `canRecover`: only when phase = `crashed`.
- `canCheckpoint`, `canPressure`, `canWait`, `canBlock`, `canHandoffReady`: refuse on terminal
  (`closed`); pressure/checkpoint additionally refuse on `crashed` (can't checkpoint a dead
  session — master §8 "can't checkpoint/pressure a terminal session", generalized to crashed).
- `canRequestClose`: refuse on terminal.
- `canClose`: only when phase = `closing` (i.e. a `session_close_requested` is the latest gate) —
  enforces "`close_session` only after `session_close_requested`".

**No-auto-close is structural**, not just guarded: `observer.ts` contains no `session_closed`
write at all (negative test greps the module + asserts no reconcile path emits it).

---

## 9. Projector + keystone (`project.ts`)

`projectSessions(all)` pure (events → `SessionState[]`, sorted by sessionId). `renderSessions`
writes `state/sessions.json` — byte-stable, the **sole** status writer (HARNESS keystone).
Already gitignored (`workspace/sessions/**/*.md`, `workspace/state/*.json`). Property test:
`render(events)` byte-identical after `state/` wipe + rebuild (clone of the task keystone test).

---

## 10. Structural invariants (master §13 — review bar)

- **#1 verdict-free**: no module writes any `decision_*`; the observer is another propose-only
  observer (master §4.1). Negative test: a full observe + record run emits zero `decision_*`,
  exposes no approve surface, and `src/session/**` imports no decision-write handler.
- **#5 on-demand, bounded**: `observe_sessions` is one pass per call; no poll loop / daemon.
- **#6 governance store separate**: observer reads cmux only; no app sqlite / UI.
- **#4 stdio**: no `bindings.ts` change.

---

## 11. Done-criteria (evidence) + 1 live smoke

1. **birth**: a Phase C `session_spawned` appears in `sessions` / `session <id>` as
   `orchestrator_owned`; no duplicate birth event.
2. **heartbeat-on-change**: two `observe_sessions` with an unchanged alive surface → exactly one
   `session_observed`.
3. **crash/recover**: surface disappears → `session_crashed`; reappears → `session_recovered`.
4. **orphan**: unknown live surface → one `session_opened` (`external_owned`); idempotent on
   re-observe.
5. **no-auto-close**: negative test — no observer path emits `session_closed`; only `close_session`
   (after `session_close_requested`) does.
6. **zero-verdict**: negative test — session module emits no `decision_*`, exposes no approve
   surface.
7. **keystone**: `state/sessions.json` byte-identical after wipe + re-derive.
8. **stub determinism**: vitest green; `BOULE_OBSERVER_MODE` unset ⇒ no cmux touched; no
   `bindings.ts`; no Postgres.

- **Live (AI-run 2026-06-03 — reconcile LOGIC GREEN 7/7, live adapter RESOLVED):** validated the
  reconcile against REAL cmux surfaces — a known session bound to a real surface → `session_observed`
  (active), exactly one across two observes (heartbeat-on-change), a fresh unmanaged surface → one
  `session_opened` `external_owned` + idempotent on re-observe, the surface removed → `session_crashed`.
  All transitions came from `observeSessions` reconciling real `cmux tree --all` surfaces.
  - ✅ **RESOLVED (2026-06-03):** `makeLiveAdapter` previously ran the invented **`cmux list`** command
    (real cmux exits status 1 "Unknown command" → adapter throws); a fake-spawn unit test asserting
    `["list"]` masked the bug. The adapter now runs **`cmux tree --all --json`** and walks
    `windows[].workspaces[].panes[].surfaces[].ref` keeping only `type === "terminal"` surface refs
    (Boule sessions are terminal agents; browser surfaces are excluded). `parseSurfaces` is defensive:
    malformed/empty stdout → `[]`; results are deduped, order-stable by first appearance. Fix plan:
    `governance/docs/plans/2026-06-03-boule-v3-phase-d-observer-live-adapter-fix.md`.
  - **Reconciliation precondition (Phase-C follow-up, NOT in scope here):** the live surface set
    uses `surface:N` cmux refs. A Phase-C `session_spawned` session reconciles correctly only if its
    stored `surface` field (sourced from `cmux new-workspace` stdout in conductor `adapter.ts`) is
    also a `surface:N` ref. Verifying and normalizing the conductor's `new-workspace` output to the
    `surface:N` form is a separate Phase-C concern and is intentionally left out of this change.

---

## 12. Deferred (each its own later spec)

- auto-pressure / auto-checkpoint computation (master §9 weighted formula — Phase G)
- handoff artifact lifecycle (Phase G)
- worktree auto-cleanup
- orchestrator "open a session for this task" suggestion (Phase E)
- Postgres ingest (Phase F)
- the `checkpointing` §8 sketch state (no Phase-D event yet)

---

## 13. Provenance

Design handed in by the user (2026-06-03), formalized against the master control-plane design
(§8/§11/§18) and the live Phase A (`task/`) + Phase C (`conductor/`) modules. The session-identity
seam (§3) and the `session_open_requested`-as-birth generalization were resolved during planning
and are flagged for the critic pass.
