# SSOT Governance Harness — Boule v3 Phase G: Context Steward / Handoff (design)

- **Date**: 2026-06-03
- **Status**: design (approved in-session; pre-plan)
- **Branch**: `feat/boule-v3-phase-d` (PARKED, unpushed — commit only, never push/merge/delete without explicit request)
- **Master design**: `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` (§8 state machines, §9 Context Steward/Handoff, §10 phase sequence, §11 event sets, §13 INVARIANTs)
- **Depends-on**: Phase E (✅ DONE, `4f93856`) for the suggestion/observe substrate; Phase F (✅ DONE, `2879fff`) graph index is *read* by hydration. Reuses the per-axis folds/projectors built in A–F.
- **Catalog**: `governance/docs/INDEX.md` (mark ✅ DONE on critic ACCEPT).

> **One-line:** add the **handoff continuity axis** (own event types + fold + structural validation +
> projector) plus a **pure Context Steward** (advisory `computeContextPressure`) and a **pure hydration
> bundle assembler** under a thin IO shell, so a long task can `checkpoint → handoff → hydrate` into a
> fresh session. Event log stays canonical; the Steward is advisory; hydration is read-assembly only.

---

## 0. Problem & Framing

Master design §0.1 fixes the keystone choice: **we don't try to hold a long context — we emit a handoff
artifact and switch sessions.** Phases A–F built the execution plane (spec/plan/task/session) and a
derived graph index; Phase E already *suggests* "this session needs a checkpoint" (the `session_checkpoint`
policy rule fires on `context_pressure_high`). What is missing is the **handoff axis itself** and the
**hydration** that lets the next session resume correctly.

This slice builds the **whole Phase G** (user-approved scope) as three concerns, each event-sourced and
pure-core-under-IO-shell, mirroring the A/E/F rhythm:

- **(A) Handoff lifecycle SSOT** — `handoff_*` events + `deriveHandoffState` fold + structural section
  validation + `renderHandoffs` projector + MCP surface.
- **(B) Hydration bundle** — a pure `assembleBundle` core (takes already-read inputs) + a thin `hydrate`
  IO shell (reads git summary + the Phase F index, emits `handoff_consumed`).
- **(C) Context Steward pressure scoring** — a pure `computeContextPressure(runtimeSignals, log)`
  returning an **advisory** weighted level. It is *not* a second writer of `session_context_pressure_changed`.

### 0.1 Settled scope decisions (this session)

1. **Whole Phase G in one slice** (A+B+C), decomposed into small TDD tasks so each is independently
   critic-able.
2. **Pressure scoring is a pure advisory function.** Caller passes runtime-only signals it observes
   (token ratio, turn count, wall-clock, files-touched); the Steward folds event-derived signals
   (unresolved `decision_blocked`, plan-step distance to a safe boundary, last-handoff age) and returns
   `{ level, score, components }`. **The observer/hermes remains the SSOT writer** of
   `session_context_pressure_changed`; the Steward emits nothing.
3. **Handoff gates:** `validating → pending | invalid` is a **pure structural check** (7 required
   sections present & non-empty → validated; else invalid → re-draft). `pending → consumed` is emitted
   when a new session **hydrates** (the `hydrate` command emits `handoff_consumed`). No human gate on
   handoffs — the HITL gate stays reserved for decisions.
4. **Hydration delivery:** `hydrate` returns a structured `HydrationBundle` **and** a rendered markdown
   string. The bundle is **returned, not persisted** as a separate artifact (event + projector already
   make it reproducible).
5. **§8-vs-§11 reconciliations** (approved): `handoff_requested` is the birth event ⇒ phase `requested`
   (absorbs §8's `drafting` — no distinct "drafting started" signal exists); `handoff_drafted` advances
   to `validating`. §11 defines **no `handoff_archived` event**, so the `archived` terminal is **deferred**
   this slice — terminal is `consumed`.

### 0.2 What this slice is NOT (explicit non-goals)

`archived` lifecycle / any `handoff_archived` event · Steward auto-emitting `session_context_pressure_changed`
or any session-axis event · pgvector/embedding-ranked bundle selection (1-hop index reads only) · persisting
the hydration bundle as a durable file · any UI (Phase H) · any new decision/task/session event type ·
any write to the decision rail · any `bindings.ts` / app-SQLite / migration change.

---

## 1. Invariants this slice must preserve (from master §13)

| # | INVARIANT | Posture in Phase G |
| --- | --- | --- |
| 1 | automation must not penetrate the decision rail | Handoff layer + Steward **emit zero** `decision_*`/`task_*`/`session_*` events. The ONLY new write is `hydrate` emitting **one** `handoff_consumed`. Folds + scoring + assembly are pure total functions (negative test). |
| 2 | external tokens in keychain | No network, no credentials introduced. |
| 3 | external network calls in Rust | No network. `hydrate` shells `git` locally (status/diff summary) and reads the local Phase F index. |
| 4 | IPC = specta-generated bindings | Governance MCP = stdio. `src/bindings.ts` **byte-unchanged** (gate). |
| 5 | bounded retry / no unbounded loops | All commands on-demand, single pass. No poll loop. Bounded `git` invocation + bounded directory scan. |
| 6 | SQLite schema via migrations only | App SQLite untouched; no migration added. Phase F index is **read-only** here (no schema change). |
| 7 | visual design = DESIGN.md | No UI in this slice. |

INVARIANT verification is a **separate critic pass** — self-approve forbidden.

---

## 2. Handoff axis — events, keying, state machine

### 2.1 Event types (added to `event/event.ts` `EventType` union — exactly §11's 5)

`handoff_requested` · `handoff_drafted` · `handoff_validated` · `handoff_invalid` · `handoff_consumed`.
Source/actor: `system`|`hermes`|`agent_run` (verdict-free, like the session axis). No new `EventSource`.

### 2.2 Keying (mirrors session/task)

- **Birth** = `handoff_requested`; `handoffId = its event id`.
- `related_to[0]` = the session id being handed off **from** (continuity origin). Optional `related_to[1+]`
  may reference the bound task/plan for assembly convenience, but the fold only requires `[0]`.
- `handoffsOf(all)` returns birth events sorted by id, excluding any `handoff_requested` that itself
  references an existing handoff birth (defensive double-count guard, clone of `sessionsOf`).

### 2.3 State machine (pure fold `deriveHandoffState`)

```
requested ──drafted──▶ validating ──validated──▶ pending ──consumed──▶ consumed (terminal)
                            │
                            └──invalid──▶ invalid ──(re-drafted)──▶ validating
```

| Event | Resulting phase |
| --- | --- |
| `handoff_requested` (birth) | `requested` |
| `handoff_drafted` | `validating` |
| `handoff_validated` | `pending` |
| `handoff_invalid` | `invalid` |
| `handoff_consumed` | `consumed` (terminal) |

`HandoffState = { handoffId, sessionId, phase, verdict: "consumed" | null }`. Precedence mirrors
`deriveSessionState`: terminal `consumed` wins; else the **latest advancing transition by id**; else the
birth phase `requested`. **Fail-closed type filter** — foreign event types ignored (god-fold ban, §8).
ORDERING CONTRACT identical to the session axis (ids are display/tiebreak-only; same-second transitions
on one handoff stream do not occur in practice).

### 2.4 Structural validation (pure)

`validateHandoff(body): { ok: boolean; missing: string[] }` checks the **7 required sections** (§8) are
present (as markdown headings) and **non-empty**:

1. Mission 2. Completed 3. Current failing point 4. Important implicit knowledge
5. Next exact steps 6. Do not do 7. Open questions

`validate_handoff` runs this on the latest `handoff_drafted` body for a handoff and emits
`handoff_validated` (ok) or `handoff_invalid` (carries `missing[]`). Mechanical; no human gate.

### 2.5 Projector

`projectHandoffs(all): HandoffState[]` (pure) + `renderHandoffs(workspaceDir): state/handoffs.json`
(the **sole** status writer; overwrites; byte-stable; fully rebuildable from events) — exact clone of the
`renderSessions`/`renderTasks` pattern.

---

## 3. Context Steward — pressure scoring (pure, advisory)

`computeContextPressure(runtimeSignals, log): ContextPressure`

```
RuntimeSignals  = { estimatedTokenRatio: 0..1, turnCount, wallClockMs, filesTouched }   // caller-supplied
EventDerived    = { unresolvedDecisions, planStepDistanceToSafeBoundary, lastHandoffAgeMs } // folded from log
ContextPressure = { level: "low"|"medium"|"high"|"critical", score: 0..1, components: {…} }
```

- **Event-derived signals** reuse existing folds: `unresolvedDecisions` = count of open `decision_blocked`
  (reuse `hasOpenBlock`-style logic); `planStepDistanceToSafeBoundary` from plan/task folds;
  `lastHandoffAgeMs` from handoff births (∞ / capped when none).
- **Weighting:** a fixed, documented weight vector; each component normalized to `0..1`; `score` = clamped
  weighted sum. **Thresholds (§9):** `low < 0.50`, `medium < 0.70`, `high < 0.85`, `critical ≥ 0.85`.
- **Advisory only:** returns the level; **emits nothing**. `wall_clock`/`now` is supplied by the caller
  (Boule scripts forbid `Date.now()`); the function is a pure total function of its inputs → fully testable.

MCP `context_pressure` is a thin read wrapper: accepts the runtime signals as args, reads the log, returns
the `ContextPressure` object. It does **not** write `session_context_pressure_changed`.

---

## 4. Hydration bundle

### 4.1 Pure core

`assembleBundle(inputs): { bundle: HydrationBundle; markdown: string }` — **pure**, takes already-read
inputs so it is unit-testable with no IO:

```
inputs = {
  handoff:        HandoffState + latest drafted body (the chosen pending handoff),
  log:            GovEvent[]    (for recent-N events, open blockers, folds),
  principles:     from the Phase 3 index ingress (in-memory),
  spec, plan, task: derived from existing folds,
  indexNeighbors: 1-hop neighbors from the Phase F graph index (read),
  gitSummary:     { status: string; diffstat: string }   // supplied by the IO shell
}
```

`HydrationBundle` fields (§9): `roleTemplate · principles · spec · activePlan · currentTask · latestHandoff
· recentEvents · gitSummary · knownRisks · nextExactSteps`. The core also renders a deterministic markdown
view of the same data.

### 4.2 Laundering-prevention (§4.4#5) — asserted in the pure core

The bundle **MUST** include all open `decision_blocked` items and the **autonomy envelope** carried by the
handoff, and **MUST NOT** contain any permission-granting / authority-expanding field. This is a **property
test** on `assembleBundle`, not prose: given a log with an open blocker, the assembled bundle surfaces it;
the bundle type has no "grant"/"approve"/"allow" field.

### 4.3 IO shell

`hydrate(workspaceDir, handoffId, gitSummary, now, rand)`:
1. Load the handoff (must be `pending`; else error — fail-closed).
2. Read the Phase F index for 1-hop neighbors of the handoff's session/task.
3. Call `assembleBundle` with the gathered inputs.
4. Emit **one** `handoff_consumed` (`related_to[0]` = handoffId).
5. Return `{ bundle, markdown }`.

`gitSummary` is read by the MCP/IO boundary (bounded `git status --porcelain` + `git diff --stat`), never
inside the pure core — keeping the core deterministic and the git call at the edge (INVARIANT #3/#5).

---

## 5. MCP surface (mirrors prior phases; on-demand, single pass)

| Command | Writes | Purpose |
| --- | --- | --- |
| `request_handoff` | `handoff_requested` | open a handoff for a session |
| `draft_handoff` | `handoff_drafted` | submit the drafted markdown body |
| `validate_handoff` | `handoff_validated` \| `handoff_invalid` | run the pure structural check on the latest draft |
| `hydrate` | `handoff_consumed` | assemble + return the bundle for a fresh session |
| `handoff_status` | — (read) | list handoffs + phases (from `projectHandoffs`) |
| `context_pressure` | — (read) | advisory `computeContextPressure` over caller-supplied runtime signals |

Each write-command emits **exactly one** event; idempotency is by lifecycle phase (e.g. `validate_handoff`
on an already-`pending`/`consumed` handoff is a no-op/explicit error, not a duplicate emit).

---

## 6. Decomposition (TDD tasks — one critic-able unit each)

1. **Event types** — add the 5 `handoff_*` to `EventType`; id/subject helpers (`handoffsOf`).
2. **`deriveHandoffState` fold** — state machine + precedence + fail-closed filter; property test.
3. **`validateHandoff`** — 7-section structural check; missing-section reporting.
4. **`projectHandoffs` + `renderHandoffs`** — `state/handoffs.json`; rebuild-equivalence test.
5. **`computeContextPressure`** — pure weighted scoring; threshold + component tests.
6. **`assembleBundle`** — pure hydration core + markdown render + laundering-prevention property test.
7. **`hydrate` IO shell** — git summary at the edge, index read, `handoff_consumed` emit.
8. **MCP wiring** — 6 commands + negative test (zero `decision_*`/`task_*`/`session_*` writes) + drift gates.

---

## 7. Observable done-criteria (evidence, not prose)

- A `request → draft(incomplete) → validate(invalid, missing[]) → draft(complete) → validate(pending) →
  hydrate(consumed)` round-trip passes headlessly in vitest; `handoff_status` reflects each phase.
- `computeContextPressure` returns `critical` for a saturated-signal fixture and `low` for an idle one;
  thresholds match §9; emits nothing.
- `assembleBundle` property test: open `decision_blocked` appears in the bundle; bundle type has no
  authority-granting field.
- **Negative test:** the whole Phase G path writes **0** `decision_*`/`task_*`/`session_*` events; only
  `hydrate` writes (one `handoff_consumed`).
- Gates: `pnpm exec tsc --noEmit` = 0 · `pnpm exec vitest run` green (+~25) · `git diff <base>..HEAD --
  src/bindings.ts` empty · `git diff <base>..HEAD -- src-tauri/migrations` empty.
- **Separate impl-critic (opus) ACCEPT 0 blockers** — self-approve forbidden.

---

## 8. Risks → mitigation

| Risk | Mitigation |
| --- | --- |
| Steward becomes a covert second writer of pressure events | Pure function, returns a value, emits nothing; MCP `context_pressure` is read-only (asserted by negative test). |
| Hydration "launders" unresolved blockers into confident resume | Open `decision_blocked` + envelope carried in the bundle by construction; property test; no authority field in the type. |
| `git` call leaks into the pure core / non-determinism | `gitSummary` is read at the IO edge and passed in; core is a pure total function. |
| Scope creep (archived, embeddings, UI) | Explicit non-goals (§0.2); terminal is `consumed`; index reads are 1-hop only. |
| Drift in `bindings.ts` / app SQLite | No Tauri IPC, no migration; byte-diff gates in done-criteria. |
