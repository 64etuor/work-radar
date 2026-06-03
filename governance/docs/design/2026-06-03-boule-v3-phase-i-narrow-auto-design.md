# SSOT Governance Harness — Boule v3 Phase I: Narrow opt-in Type-2 Auto (design)

- **Date**: 2026-06-03
- **Status**: design (pre-plan, parked) — 🆕 authored + self-reviewed this session, awaiting separate plan-critic. **SPEC ONLY — no implementation code, no push/merge/delete/deploy, no permission/credential approval until explicit user go.**
- **Branch**: `feat/boule-v3-phase-d` (PARKED, unpushed)
- **Master design**: `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` (§4 orchestrator-by-construction, §4.2 human gates, §4.3 anemic auto, §4.4 failure modes→mitigation, §4.5 command-surface separation, §4.6 new decision rail, §10 row I, §11 dispatch event set)
- **Depends-on**: Phase **C** envelope+conductor (✅ the bounded executor this phase dispatches) · Phase **E** (✅ orchestrator read half) · Phase **G** (✅ continuity). Reuses A–G folds.
- **Catalog**: `governance/docs/INDEX.md` (mark ✅ DONE only on separate impl-critic ACCEPT).

> **One-line:** build the orchestrator's **execute half** — but anemic. An **opt-in, on-demand**
> `auto_dispatch` pass auto-advances **human-accepted plans** by reusing the **already-safe Phase-C
> `conduct_plan`** (bounded one-step, envelope-scoped, role-gated, halt-on-block), leaving a full
> **deny-by-default** dispatch audit trail. It mints **zero `decision_*`**, has **no approval / timeout /
> default / scope-expansion path**, and Type-1 stays human-gated. "Auto" = the orchestrator chooses
> *which already-human-approved plan steps to advance*, never *what to approve*.

---

## 0. Problem & Framing

Phase E built the orchestrator's **read half** (it *suggests*). Master §4.1's **execute half** (Scheduler ·
Session Manager · Action Dispatcher) was deferred to here. The honest tension (master §4.3): we want
*some* unattended forward motion, but every safety guarantee makes "auto" **narrower and slower**. The
master already chose **anemic auto** — Phase I wires the smallest execute path that is **structurally
unable** to penetrate the decision rail, and proves it. Master §4.3 names that path exactly: *"bounded
session spawn of **already-human-approved plan steps**."* That is what Phase I automates.

### 0.1 The autonomy boundary — what becomes autonomous, and the structural proof it stays safe

> **Autonomous in this phase:** given **one explicit, opt-in invocation**, the orchestrator advances
> every **human-accepted plan** that has a ready next step — by firing the existing **`conduct_plan`**
> (≤1 step, isolated worktree, envelope, role-gated session, halt-on-block) — **without a per-step human
> poke**. That is the entire new autonomy.
>
> **NOT autonomous (structurally unreachable):** approving any decision, resolving a `decision_blocked`,
> marking a Type-1 accepted, advancing a plan that is **not** human-accepted, expanding scope, changing
> an L4 principle, or running as a background daemon.

The structural proof (not policy, not prompt):

1. **No verdict write-path — by import.** The Phase I dispatcher imports **zero** decision write
   handlers (clone of the Conductor's discipline, Phase C §8). It can emit only the new **non-verdict**
   dispatch events + call `conductPlan` (which itself imports zero decision handlers). No code path runs
   from `auto_dispatch` to `decision_approved`/`_rejected`/`_chosen` — those stay hardpinned
   `actor:"user"` in `decision/handlers.ts`. A **negative test** asserts the auto pass writes no `decision_*`.
2. **Human-accepted-only, by construction.** `conduct_plan`'s precondition is `derivePlanState(plan).phase
   === "active"`, and a plan reaches `active` only via `plan_accepted` (`actor:"user"`). The dispatcher
   re-checks this (G1) so a non-accepted plan is a *recorded, explained* `action_denied(plan_not_accepted)`,
   never a silent spawn. **No scope expansion**: auto touches only what a human already approved.
3. **Opt-in flag gates dispatch, not approval — separate code (master §4.4#3).** `BOULE_AUTO_MODE` enables
   only the dispatch loop; it is **not** a parameter to `canApprove`/`canComplete`/`canAdvance` (pure
   functions, no mode arg — verified as-built). A negative test asserts: with `BOULE_AUTO_MODE=type2`,
   `approve` of an unreviewed Type-1 **still refuses**. "Auto" is a dispatch property, never an approval one.
4. **Halt-on-block is inherited, timeout-free.** `conduct_plan`'s `canAdvance` refuses while any step has
   an open `decision_blocked`, with **no timeout/default/skip** (Phase C §4, verified). A Type-1 boundary
   hit by the spawned session → `escalate` → `decision_blocked` + halt, **forever**, until a human
   `choose`/`approve` (master §4.4#1: bound the session, never the decision). The next `auto_dispatch`
   pass over a halted plan emits `action_denied(halted)`, advancing nothing.

### 0.2 Settled scope decisions (this session — Hermes-delegated, pre-plan, spec only)

1. **The dispatcher drives off conductor-advanceability, not E suggestions.** `auto_dispatch` reads each
   `active` plan's `deriveConductorState` and dispatches `conduct_plan` where `canAdvance` is ok.
   *(Self-review correction: none of Phase E's 5 suggestion rules cleanly drives `conduct_plan` —
   `task_needs_session` asks for a session for an existing task, which `conduct_plan` does not do.
   Conductor-advanceability is the honest, substrate-matching trigger.)* E's suggestions remain
   human-facing advisories; a suggestion→dispatch pipeline is a fork (§9 F2).
2. **Reuse `conduct_plan`, invent no new action.** Phase I adds the *decision to fire it*, the
   *deny-by-default gate*, and the *audit trail* — nothing about how sessions run.
3. **On-demand, not a daemon (INVARIANT #5).** `auto_dispatch` is one bounded pass over the current
   `active` plans, invoked by a human/Hermes (latency is the feature, master §7). No poll/watcher/auto-fire.
4. **Opt-in flag domain = `{off (default), type2}`.** No value enables Type-1 auto-approval; off ⇒
   `auto_dispatch` refuses (deny-by-default at the mode level).
5. **At most one step per plan per pass.** `conduct_plan` already advances ≤1 step; the dispatcher fires
   it at most once per `active` plan per pass. Strictly sequential within a plan (Phase C); no parallel fan-out.
6. **Headless MCP, stdio.** No UI, **no `bindings.ts` change**, no app SQLite/migration. The Control Room
   surfacing of the dispatch log is a deferred Phase-H slice.
7. **Path-glob enforcement stays advisory** (inherited from Phase C). Hardening to a real in-worktree
   pre-write check is an explicit open fork (§9 F1), not slice 1 — structural safety = worktree isolation
   + verdict-tool absence + halt-on-block; the residual (a misbehaving model editing an in-worktree file
   outside its glob) is stated plainly, not hidden.

### 0.3 What this slice is NOT (explicit non-goals)

- No auto-approval, no `decision_*` write, no resolving `decision_blocked`, no Type-1 handling.
- No timeout / default / skip / "assume yes after N" — anywhere.
- No new action beyond `conduct_plan`; no parallel fan-out; no session auto-close; no `plan_completed` automation; no `start_task`/`cancel_task`/`block_task` auto.
- No advancing plans that aren't human-accepted (`active`).
- No background daemon / poll / watcher; no auto-trigger of `auto_dispatch`.
- No consumption of E suggestions in slice 1 (advisory only).
- No UI, no `bindings.ts`, no app SQLite/migration, no Postgres dependency.
- No `instruction_sent`/`instruction_rejected_by_policy`/`projection_rebuilt` events (master §11 lists them; slice 1 uses the minimal subset §4 and defers the rest).
- No hardened in-worktree path-glob pre-write enforcement (stays advisory, §0.2.7).

---

## 1. INVARIANTs this slice must preserve (master §13)

| # | INVARIANT | Posture in Phase I Slice 1 |
| --- | --- | --- |
| 1 | **automation must not penetrate the decision rail** | The crux. Structural by **four** independent mechanisms (§0.1): no verdict import; human-accepted-only precondition; flag gates dispatch not approval (separate code); timeout-free inherited halt-on-block. Type-1 spawn boundary → `decision_blocked` + permanent halt. Enforced by **negative tests** (master §4.6: the negative test is the real guard, not the prose rail). |
| 2 | external tokens in keychain | No tokens. (Live spawn's cmux/git creds are Phase-C's concern, unchanged.) |
| 3 | external network calls in Rust | No network in the dispatcher; it reads local events + calls `conduct_plan`. Live spawn shells git/cmux at Phase-C's existing boundary only. |
| 4 | IPC = specta-generated bindings | Governance MCP = **stdio**. `src/bindings.ts` **byte-unchanged** (gate). |
| 5 | bounded retry / no unbounded loops | `auto_dispatch` = one on-demand pass over current `active` plans; at-most-one dispatch per plan; **no poll loop, no daemon**. Bounded recovery is `conduct_plan`'s existing live behavior. |
| 6 | SQLite schema via migrations only | App SQLite untouched; no migration. Spawn writes only inside the isolated worktree (Phase C). |
| 7 | visual design = DESIGN.md | No UI in this slice. |

INVARIANT verification is a **separate critic pass** (opus) — self-approve forbidden.

---

## 2. Architecture — propose-only dispatcher over the Phase-C executor

```
events/*.md ──readAllEvents──▶ GovEvent[]
      │
      ▼
projectPlans(events)  +  deriveConductorState(plan, events)   ← PURE reads (Phase B/C), no emit
      │   active plans              per-plan: { cursor, halted, done }
      ▼
evaluateAutoDispatch(plan, conductorState, mode)              ← PURE Safety Gate (deny-by-default, §3)
      │   { decision: "allow", action:{conduct_plan,planId} } | { decision:"deny", reason }
      ▼
auto_dispatch (IO shell, opt-in BOULE_AUTO_MODE=type2)        ← the ONE new write boundary
      │   per active plan, at most once, not-yet-dispatched-for-this-step:
      │     allow ▶ emit instruction_planned(related_to:[planId], body:{stepIndex})
      │             call conductPlan(planId) ─▶ Phase C bounded 1-step spawn (envelope, role-gated, halt-safe)
      │                success ▶ orchestrator_action_executed
      │                refuse/err ▶ orchestrator_action_failed(reason)
      │     deny  ▶ emit action_denied(reason)        // mode_off handled before any emit (§5)
      ▼
auto_status / dispatch_log (read-only)                        ← list instruction_planned + action_* outcomes
```

- **Two pure cores + one IO shell** (mirrors E/G rhythm). `evaluateAutoDispatch` is a **pure total
  function** (no I/O, no emit) → fully table-testable. Emission happens only in `auto_dispatch`.
- **The dispatcher composes, it does not re-implement.** It reuses `projectPlans`/`derivePlanState`,
  `deriveConductorState`, and `conductPlan` unchanged (god-fold ban, master §8). It owns no fold, no spawn.
- **`conduct_plan` is the only action.** Its preconditions (plan `active` = human-accepted; halt while
  blocked; one-step-per-call) *are* the safety; the gate re-checks them so a denial is **explained**
  (recorded `action_denied`) rather than swallowed by `conduct_plan` returning `ok:false`.

### 2.1 New module `src/orchestrator/dispatch/` (proposed)

| file | export | role | purity |
| --- | --- | --- | --- |
| `dispatch/policy.ts` | `evaluateAutoDispatch(input): AutoDispatchVerdict` | the deny-by-default Safety Gate (§3) | **pure** (I/O·emit 0) |
| `dispatch/dispatch.ts` | `autoDispatch(workspaceDir, deps, mode, now, rand): Promise<DispatchSummary>` | read→evaluate→dedup→emit trail→`conductPlan`. The one boundary. | impure (1 boundary) |
| `dispatch/project.ts` | `listDispatchLog(workspaceDir): Promise<DispatchLogEntry[]>` | read-only render of `instruction_planned` + `action_*` | read only |

`dispatch.ts` imports `conductor/handlers.ts` (`conductPlan`) + plan/conductor reads — **never
`decision/handlers.ts`** (the structural #1 guard, asserted by a negative test). It receives the same
`ConductorAdapter` dep as `conduct_plan` (stub in tests; live behind `BOULE_CONDUCTOR_MODE`).

```ts
type AutoDispatchVerdict =
  | { decision: "allow"; action: { kind: "conduct_plan"; planId: string; stepIndex: number }; reason: string }
  | { decision: "deny"; reason: AutoDenyReason };

type AutoDenyReason = "mode_off" | "plan_not_accepted" | "halted" | "in_flight" | "done";

interface AutoDispatchInput {
  plan: PlanState;                 // a candidate plan (projectPlans)
  conductor: ConductorState;       // deriveConductorState(plan, events): { cursor, halted, done, ... }
  mode: "off" | "type2";           // parsed from BOULE_AUTO_MODE (default off)
}
```

---

## 3. The Safety Gate — `evaluateAutoDispatch` (deny-by-default)

Returns `allow` **iff every** condition holds; otherwise `deny` with the first failing reason. This is a
**re-statement of `canAdvance`** plus the opt-in gate, but it *records* each refusal (deny-by-default
audit) instead of letting `conduct_plan` silently no-op.

| # | condition | deny reason | rationale |
| --- | --- | --- | --- |
| G0 | `mode === "type2"` | `mode_off` | opt-in; `off` ⇒ deny (anemic auto, deny-by-default at the mode level). |
| G1 | `plan.phase === "active"` | `plan_not_accepted` | `active` ⇔ a human ran `plan_accepted` (master §4.2). No scope expansion beyond approved work. |
| G2 | `conductor.halted === false` | `halted` | never advance over an open `decision_blocked` (INVARIANT #1; timeout-free). |
| G3 | `conductor.done === false` AND `conductor.cursor !== null` | `done` / `in_flight` | there is a ready next step (not all-terminal `done`; not an in-flight `active` step ⇒ `cursor===null`). |

`allow` ⇒ `action = { kind:"conduct_plan", planId: plan.planId, stepIndex: conductor.cursor }`. Every
`deny` carries its machine reason for the `action_denied` body and the audit/replay surface.

> **Why re-check what `conduct_plan` already checks?** Defense-in-depth + auditability: the denial is a
> *recorded, explained* `action_denied`; relying solely on `conduct_plan`'s internal `ok:false` would lose
> the deny-by-default trail and blur "the orchestrator chose not to" vs. "the action failed."

---

## 4. Events + dedup / idempotency

New `EventType`s (added to `event/event.ts` — the minimal subset of master §11's dispatch set):

```
| "instruction_planned"            // orchestrator decided to advance a plan step (intent; dedup key)
| "orchestrator_action_executed"   // the dispatched conduct_plan succeeded
| "orchestrator_action_failed"     // the dispatched conduct_plan refused/errored (carries reason)
| "action_denied"                  // Safety Gate denied advancing a plan (carries machine reason)
```

All **verdict-free**, `source: "system"`, `actor: "system"`. No new `EventSource`. `related_to: [planId]`;
body = canonical JSON `{ planId, stepIndex, reason? }`.
(`instruction_sent`/`instruction_rejected_by_policy`/`projection_rebuilt` from master §11 are **deferred** —
`instruction_sent` collapses into `instruction_planned`+`executed`; `_rejected_by_policy` ≡ `action_denied`;
`projection_rebuilt` is a Phase-F index concern.)

**Dedup (clone of Phase E `suggest`):** key an `instruction_planned`/`action_denied` by `(planId, stepIndex)`.
A second `auto_dispatch` pass with no state change emits **0** new events for an already-dispatched-or-denied
`(plan, step)`. Per-emission `now + i*1000` offset → distinct ordered ids.
`DispatchSummary { executed: number; failed: number; denied: number; skipped: number }`.

> **Natural idempotency reinforcement:** after a successful dispatch, the plan's step is `active`
> (in-flight) ⇒ `cursor===null` ⇒ G3 denies `in_flight` on the next pass; combined with the
> `(planId, stepIndex)` dedup, a re-run advances nothing. After the step completes, the cursor moves to a
> *new* stepIndex ⇒ a new dispatch key. **Re-arm limitation (documented):** a step that recurs at the same
> index is not re-dispatched — a dispatch lifecycle is deferred (mirrors E's deferred suggestion lifecycle).

---

## 5. MCP surface (stdio — INVARIANT #4 non-subject)

| tool | gating | writes | purpose |
| --- | --- | --- | --- |
| `auto_dispatch` | **opt-in**: refuses unless `BOULE_AUTO_MODE=type2`; verdict-free (executor-role gate non-subject, like `suggest`) | per allow: `instruction_planned` + (`orchestrator_action_executed`\|`orchestrator_action_failed`); per deny: `action_denied` | one on-demand pass: advance every advanceable human-accepted plan via `conduct_plan`, deny the rest |
| `auto_status` / `dispatch_log` | none (read-only) | — | list recent `instruction_planned` + `action_*` outcomes (`listDispatchLog`) |

- `auto_dispatch` registration mirrors `suggest`'s position (verdict-free; **not** in the
  `SESSION_ALLOWS_VERDICTS` block). The opt-in refusal is inside the handler: `mode==="off"` ⇒ return
  `{ ok:false, reason:"auto disabled (set BOULE_AUTO_MODE=type2)" }` and emit **nothing** (deny-by-default;
  no `action_denied`, since nothing was evaluated).
- The dispatcher shares `conduct_plan`'s `ConductorAdapter` (stub default; live behind `BOULE_CONDUCTOR_MODE`).
- Approval endpoints stay unexposed to executor sessions (master §4.5, Phase C role-gate) — unchanged.
- `BOULE_AUTO_MODE` parsed in `mcp/config.ts` (clone of `parseConductorConfig`); default `off`.

---

## 6. Decomposition (TDD tasks — one critic-able unit each)

1. **Event types** — add the 4 dispatch types to `EventType`; canonical body helpers.
2. **`evaluateAutoDispatch`** — pure Safety Gate; **table test** every G0–G3 fire/deny path (deny-by-default
   proven: mode off, non-accepted plan, halted, done, in-flight all → deny with the right reason; only an
   `active` + not-halted + ready-cursor plan → allow).
3. **`autoDispatch` IO shell** — read→evaluate→dedup→emit trail→`conductPlan` (inject `ConductorAdapter`
   stub). Tests: one advanceable accepted plan → `instruction_planned`+`orchestrator_action_executed` + the
   conductor stub spawned step 1; idempotency (pass2 emits 0 for the same step); denied plan → `action_denied(reason)`.
4. **Negative tests (the real #1 guard)** — `auto_dispatch` writes **0** `decision_*`; with
   `BOULE_AUTO_MODE=type2`, `canApprove`/`approve` of an unreviewed Type-1 still refuses (flag ≠ approval
   gate); a Type-1 escalation from the spawned step leaves a `decision_blocked`, and the next pass emits
   `action_denied(halted)` and advances nothing (no auto-resolve, no timeout).
5. **`listDispatchLog` + MCP wiring** — `auto_dispatch`/`auto_status` tools; opt-in refusal path; config
   parse; drift gates (`bindings.ts` byte-unchanged).

Pure cores (`evaluateAutoDispatch`) unit-tested exhaustively; the IO shell is thin.

---

## 7. Observable done-criteria (evidence, not prose)

1. Seed: an `active` (human-`plan_accepted`) plan with a ready next step (no in-flight, not halted). With
   `BOULE_AUTO_MODE=type2`, `auto_dispatch` → `instruction_planned` + `orchestrator_action_executed`; the
   conductor stub spawned step 1 (`task_created`+`step_bound`+`session_spawned`+`task_started`). `dispatch_log` shows it.
2. `BOULE_AUTO_MODE` unset ⇒ `auto_dispatch` refuses, emits **0** events (no `action_denied`).
3. Plan in `draft`/`needs_revision` (not human-accepted) ⇒ **`action_denied(plan_not_accepted)`**, no `conduct_plan`.
4. Plan with an open `decision_blocked` on a step ⇒ **`action_denied(halted)`**, no dispatch; stays denied across passes until a human `choose` clears it.
5. Plan whose current step is in-flight (`active`) ⇒ **`action_denied(in_flight)`**; fully-conducted plan ⇒ `action_denied(done)`.
6. **Negative #1 (structural):** across all the above, `auto_dispatch` writes **0** `decision_*`; and with `BOULE_AUTO_MODE=type2`, `approve` of an unreviewed Type-1 **still refuses** (flag ≠ approval gate).
7. **Idempotency:** `auto_dispatch` twice (no state change) → 2nd pass `executed:0` for the already-advanced step (`(planId,stepIndex)` dedup + `in_flight` deny).
8. **Halt-no-resolve:** the spawned step escalates a Type-1 → bound `decision_blocked` halts the plan; the next `auto_dispatch` does **not** advance or resolve it (stays halted until human `choose`).
9. Gates: `pnpm exec tsc --noEmit` 0 · `pnpm exec vitest run` green (record count) · `git diff <base>..HEAD -- src/bindings.ts` empty · `git diff -- src-tauri/migrations` empty.
10. **Separate impl-critic (opus) ACCEPT 0 blockers** — self-approve forbidden. **Live `BOULE_AUTO_MODE=type2`+`BOULE_CONDUCTOR_MODE=live` smoke = user-run** (real cmux spawn; agent cannot drive the native session) — report "could not run" ≠ "passed".

---

## 8. Risks → mitigation

| Risk | Mitigation |
| --- | --- |
| **Scheduler becomes a de-facto decider via timeout/default (master §4.4#1, top risk)** | No timeout/default/skip; `canAdvance`/gate halt forever on block; auto writes no verdict. Negative test #6/#8. |
| **Scope expansion — auto-advances unapproved work** | G1: only `active` (= `plan_accepted`) plans; non-accepted ⇒ recorded `action_denied(plan_not_accepted)`. |
| **Opt-in flag globally disables gates (§4.4#3)** | Flag gates dispatch only; `canApprove`/`canComplete`/`canAdvance` take no mode arg (verified pure). Negative test asserts approval gate unaffected. |
| **Dispatch over an open fork** | G2 (`halted`) + `conduct_plan`'s own halt + complete-coupling; recorded `action_denied(halted)`. |
| **Classification drift (Type-1 advanced as Type-2, §4.4#2)** | Auto never *classifies* or *approves* — it only advances approved plans; any Type-1 inside the work surfaces as the spawned session's `decision_blocked` (halt), never an auto-verdict. |
| **Daemon creep / runaway loop (INVARIANT #5)** | On-demand single pass; ≤1 dispatch per plan; `(planId,stepIndex)` dedup; no poll/watcher. |
| **Advisory path-globs let a spawned model edit outside its glob (inherited Phase C residual)** | Stated plainly (§0.2.7); structural safety = worktree isolation + verdict-tool absence + halt-on-block. Hardening = fork F1. |
| **Dispatch event flood** | `(planId,stepIndex)` dedup (Phase E mirror); idempotency test #7. |
| **bindings.ts / migration drift** | stdio MCP, no UI; byte-diff gates #9. |

---

## 9. Provenance / open items

- **Grounding (2026-06-03):** master §4/§10/§11; the Phase C conductor/envelope design; and a thorough
  as-built substrate map — `event/event.ts` union (confirmed all dispatch types **missing**, only
  `orchestrator_suggestion_created` exists), `conductor/{handlers,guards,envelope,adapter}.ts`
  (`conductPlan`, `canAdvance`/`ConductorState{cursor,halted,done}`, `AutonomyEnvelope`,
  `BOULE_CONDUCTOR_MODE`, the `BOULE_SESSION_ROLE=executor` server role-gate + `--strict-mcp-config`/`--disallowedTools`
  defense-in-depth), `orchestrator/{policy,suggest,project}.ts` (`(rule,subject)` keying), `decision/{guardian,handlers}.ts`
  (`canApprove`, `actor:"user"` hardpin — no non-user verdict path), `plan/*` (`plan_accepted`→`active`),
  and the `mcp/server.ts` gated-registration pattern.
- **Self-review correction (this session):** the first draft coupled the E suggestion `task_needs_session`
  → `conduct_plan`; that is a semantic mismatch (`conduct_plan` materializes a plan's *next step*, it does
  not spawn a session for an existing task; and conductor-spawned tasks already carry a session, so the
  rule mostly fires for non-plan manual tasks → always denied). Corrected to drive off
  **conductor-advanceability of `active` plans** — the real substrate primitive and the literal master
  §4.3 action.
- **Forks resolved here:** master §16's deferred autonomy-envelope/dispatch detail → **opt-in, on-demand,
  conduct_plan-only, deny-by-default, headless** (§0.2).
- **Open forks for the plan / future slices:**
  - **F1 — hardened path-glob pre-write enforcement** (in-worktree). Inherited-advisory in slice 1.
  - **F2 — suggestion-mediated dispatch.** Add a Phase-E `plan_step_ready` rule so the human sees a
    "conduct again" suggestion before enabling auto (master/Phase C §7 anticipated this). Slice 1 reads
    advanceability directly; the suggestion intermediary is a later refinement.
  - **F3 — more Type-2 actions** (e.g. bounded recovery re-spawn for a step whose session crashed;
    auto-`start_task`). Each new action re-justified as unambiguous + bounded.
  - **F4 — Control Room dispatch/timeline panel** (Phase H deferred slice) surfacing the dispatch log read-only.
  - **F5 — full master §11 dispatch event set** (`instruction_sent`/`_rejected_by_policy`/`projection_rebuilt`) if richer audit granularity is wanted.
- **ADR candidate:** the new decision rail (master §4.6 — "orchestrator/scheduler/dispatcher modules have
  no `decision_*` write-path; a spawn that hits a Type-1 boundary must emit `decision_blocked` and halt,
  never self-resolve") is now *exercised by an auto path* → worth promoting to `docs/adr/` + a
  `decision-rails.md` line, with the negative test cited as enforcement.
- **This spec is pre-plan and SPEC-ONLY.** Next: a **separate plan-critic** on the implementation plan;
  then TDD per §6; then a **separate impl-critic (opus) ACCEPT** before INDEX ✅ DONE. **No auto-execution
  code, no push/merge/delete/deploy, no permission/credential approval** without explicit user request —
  the autonomy boundary (§0.1) is exactly where a human go is required before building.
