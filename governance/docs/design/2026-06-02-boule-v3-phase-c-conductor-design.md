# Boule v3 Phase C — Conductor + Autonomy Envelope (Design)

> **Status:** DRAFT (2026-06-02) — branch `feat/boule-v2-planner`, on top of Phase B/B2 (`6d61af6`). Depends on B (Plan+Planner, DONE) + escalation spine (BUILT). Master: [v3 control plane](2026-06-02-boule-v3-orchestrator-control-plane-design.md) §10 row C / §8 god-fold / §11 typeset / §14#7 envelope-not-decorative. Precedent: [v2 HITL](2026-06-01-ssot-governance-harness-hitl-plan-loop-design.md) §3.4–3.8. Resolved via opus architect pass (read-only).

## 1. Goal

A **dispatcher, not a decider**: one MCP command (`conduct_plan`) that, per on-demand call, advances a **human-accepted** plan by **at most one step** — minting a task for the next unstarted step, spawning **one isolated cmux session** bound to that task, and stopping. Advancement is a **pure projection** over events (plan body steps × task states × `decision_blocked`); no daemon. The Conductor owns **zero `decision_*` write-path** and has **no `approve`** — both structural.

**Observable Done (master §10 C):** session spawn → observe `task_completed`/`decision_blocked` → pointer advance; approve capability 0.

## 2. Identity edges (all event-reconstructable)

```
planId ↔ stepIndex ↔ taskId ↔ session(surface)
plan_proposed(planId).body line k                          = step k
step_bound(related_to:[planId], body:{stepIndex:k,taskId}) = binds step k ↔ task
session_spawned(related_to:[taskId], body:{surface,worktree,envelopeHash,envelope}) = binds task ↔ session
task_started/completed/blocked(related_to:[taskId])        = the session's observable progress
decision_blocked(related_to:[decisionId, taskId])          = halt signal (escalate gains relatedTaskId)
```

`escalate()` gains an optional `relatedTaskId`; when a spawned session escalates, the `decision_blocked` binds the task id, so Phase A's `hasOpenBlock` + `canComplete` guard (`task/guards.ts`) **becomes Phase C's free INVARIANT-#1 enforcement** — a task cannot complete over an open fork.

## 3. New event types (minimal — no Phase D/E theft, no god-fold)

```
| "step_bound"       // v3 Phase C: binds a plan step index ↔ a task (actor=conductor); NO verdict
| "session_spawned"  // v3 Phase C: records one cmux session spawn for a task (actor=conductor); NO verdict
```

`session_spawned` ≠ Phase-D `session_opened` (registry/heartbeat lifecycle). No `instruction_*` (Phase E). `deriveConductorState(plan, allEvents)` is a **composing projection** — it reads `step_bound`/`session_spawned` and *delegates* to `derivePlanState`/`deriveTaskState`/`hasOpenBlock`; it owns no terminal verdict. Three independent folds, each fail-closed on foreign types (god-fold ban §8).

```ts
interface ConductorStepState { stepIndex: number; text: string; taskId: string|null; surface: string|null; taskPhase: TaskPhase|null; halted: boolean; }
interface ConductorState { planId: string; planPhase: PlanPhase; steps: ConductorStepState[]; cursor: number|null; halted: boolean; done: boolean; }
```

## 4. Pointer rules (derived; no stored cursor)

- **Precondition:** `derivePlanState(plan).phase === "active"` (human `accept_plan` is the gate). Else `conduct_plan` refuses.
- **Per step k:** the `step_bound` with `body.stepIndex===k` & `related_to ∋ planId` → taskId; `deriveTaskState` + `hasOpenBlock` → phase + `halted_k`. No step_bound → unmaterialized.
- **Halt rule (safety core):** any `halted_k` → `halted=true`; `conduct_plan` advances **nothing**, returns the halting step + open decision. Stays halted across calls until a human `choose`/`approve` resolves AND the session `task_started`-unblocks. **No timeout, no default, no skip** — bound the session, never the decision (§4.4#1).
- **Advance rule:** `cursor` = lowest k that is unmaterialized AND all prior steps terminal-done. Materialize that one step (mint task + spawn + bind). A step already `active` = in-flight → wait (advance nothing). **Strictly sequential**; parallel fan-out deferred to Phase D.
- **done:** every step materialized & terminal (done/cancelled), none unmaterialized. The Conductor never mints `plan_completed` (stays a Phase-B human transition).

## 5. Autonomy envelope

```ts
interface AutonomyEnvelope {
  planId: string; stepIndex: number; taskId: string;
  worktreePath: string;                    // the ONLY writable tree (INVARIANT #6)
  allowedPathGlobs: string[];              // ADVISORY (see below)
  allowedType2Actions: string[];           // whitelist, advisory
  forbiddenDecisionClasses: AmbiguityKind[];
  escalationTriggers: string[];
  escalateOnAnyBoundaryCrossing: true;     // MUST escalate+halt, never self-resolve
}
```

Carried **both** as the `session_spawned` body (event-sourced/auditable) **and** as `<worktree>/.boule/envelope.json` + injected into the spawn prompt; an `envelopeHash` (sha256 canonical JSON) in the body makes file vs event tamper-evident.

**Enforcement — honest split (§14#7):**
- **Structural (load-bearing):**
  1. **Worktree isolation** — session `--cwd <isolated worktree>` physically cannot touch the user tree (INVARIANT #6).
  2. **No verdict path — at TWO levels.** (a) *Conductor module*: imports zero decision write handlers; `conduct_plan` mints only `task_*`/`step_bound`/`session_spawned`. (b) *Spawned session*: it is launched against a **scoped executor-role MCP config** (`<worktree>/.boule/mcp.json`) that starts the boule server with `BOULE_SESSION_ROLE=executor`, under which the server **does not register** the verdict tools (`approve`/`reject`/`choose`/`accept_plan`/`accept_spec`) at all — they are *absent* from the session's tool surface, not merely prompt-discouraged. `--strict-mcp-config` ignores the user's global servers and a `--disallowedTools` denylist is added as defense-in-depth. The session can `escalate` (mints no verdict) + `complete_task` + read; it **cannot resolve a fork**. This makes session verdict-isolation structural (server-gated), closing the round-1 critic MAJOR.
  3. **Complete-coupling** — open `decision_blocked` structurally refuses `task_completed`.
- **Advisory (NOT a guarantee):** `allowedPathGlobs`/`allowedType2Actions`/`forbiddenDecisionClasses` are prompt contracts + audit surface. **In-worktree path-glob enforcement is advisory in Phase C** — a misbehaving model could edit an in-worktree file outside its glob. Hardening to a real pre-write check is a Phase-D/I follow-up. Stating this plainly avoids the "decorative envelope" trap.
- **Live-wiring residual:** the session-gate's strength depends on the spawned `claude` honoring `--mcp-config`/`--strict-mcp-config` and the boule server reading `BOULE_SESSION_ROLE`. The **server role-gate is verifiable headlessly now** (`tools/list` under `BOULE_SESSION_ROLE=executor` omits the 5 verdict tools); the CLI-flag half is settled in the user-run live smoke. The `--disallowedTools` denylist is a second independent barrier so a config-wiring slip still denies verdict tools.

## 6. Worktree + cmux adapter (DI seam)

```ts
interface ConductorAdapter {
  createWorktree(spec): Promise<{ path: string }>;
  spawnSession(spec): Promise<{ surface: string }>;
  writeEnvelopeFile(path, envelope): Promise<void>;
}
```

- **stub (default, tests/CI):** deterministic, touches no git/cmux/fs (returns fixed path + `surface:stub-<k>`).
- **live (`BOULE_CONDUCTOR_MODE=live`):** real `git -C <repoRoot> worktree add --detach <worktreesRoot>/boule-<plan>-step<k> HEAD` (gitignored root, never user tree) + `cmux new-workspace --cwd <wt>` (capture `surface:N`) + `cmux send --surface <S> "claude \"$(cat <wt>/.boule/step-prompt.md)\"\n"`. Knobs in `mcp/config.ts`: `BOULE_CONDUCTOR_MODE`, `BOULE_CONDUCTOR_CMUX_CMD` (default the app bin), `BOULE_CONDUCTOR_WORKTREES_ROOT`. Mirrors the `liveReviewer`/`BOULE_REVIEWER_MODE` stub-vs-live gating exactly. Non-determinism (child_process/fs) injected at the `server.ts` boundary only.

**Spawn prompt** = step text + inlined envelope + the rule: *"Type-2 micro-decisions inside allowedPathGlobs are yours. The instant you hit a Type-1 boundary / new dependency / invariant conflict / ambiguous intent, call `escalate(question, options[], relatedTaskId='<taskId>')` and STOP. You have NO approve/reject/choose. Call `complete_task('<taskId>')` only when genuinely done with no open block."*

## 7. Observation seam (daemon-free)

The Conductor learns outcomes on the **next** `conduct_plan`/`conductor_status` call via `readAllEvents` + re-derive. No poll, no watcher, no heartbeat (INVARIANT #5). Who re-invokes = a human/Hermes on-demand (latency is the feature); a Phase-E projector may later *suggest* "conduct again" but must never auto-fire.

## 8. Module layout + MCP surface

`governance/src/conductor/{conductor,guards,envelope,adapter,handlers}.ts`; tests `governance/test/conductor/{conductor,guards,envelope,handlers,negative}.test.ts`. `handlers.ts` imports read/compose (`readAllEvents`, `derivePlanState`, `deriveTaskState`, `hasOpenBlock`) + task/step/session writes only — **never `decision/handlers.ts`**.

MCP (2 tools, stdio → no `bindings.ts`): `conduct_plan {planId}` (the only write; advance ≤1 step) · `conductor_status {planId}` (read-only render). **No `conductor_approve`/`conductor_resolve`** — resolution flows only through existing human-gated `choose`/`approve`.

Modified: `src/event/event.ts` (+2), `src/escalate/escalate.ts` (+`relatedTaskId`), `src/mcp/{server,config}.ts`, `.gitignore` (+`.boule-worktrees/`).

## 9. Structural-invariant mapping

| Invariant | Mechanism |
|---|---|
| #1 no rail penetration | `conductor/` imports zero decision write handlers; `conduct_plan` mints only `task_*`/`step_bound`/`session_spawned` (verdict-free); negative test asserts no `decision_*` write + no approve surface. |
| #1 halt-on-block (no auto-default) | `ConductorState.halted` while any step's task has an open `decision_blocked`; `canAdvance` refuses; no timeout/default code path. Resolution needs `actor:"user"`. |
| #1 complete-coupling | session `escalate(relatedTaskId)` → `decision_blocked.related_to ∋ taskId` → Phase-A `canComplete` refuses (reused unchanged). |
| #4 / #5 / #6 / #7 | stdio (no bindings); on-demand (no daemon, bounded live retries); real `git worktree` isolation (never user tree); no UI. |

## 10. Deferred (each its own later spec+plan+critic)
Phase D (session registry/heartbeat/orphan/worktree auto-cleanup), Phase E (orchestrator + `instruction_*` + "conduct again" suggestion), parallel fan-out, session-output integration/merge, **hardened structural path-glob enforcement**, execution-time Type-0 Telegram routing (stays the v2 bridge's job; Phase C only emits a properly-bound `decision_blocked`), `plan_completed` automation.

## 11. Done-criteria — 8 headless (evidence) + 1 live smoke
1. accept-gate: `conduct_plan` on draft/needs_revision refused; only active spawns. 2. one-step-per-call: first call mints exactly task_created+step_bound+session_spawned+task_started for step 1, nothing for step 2. 3. observe→advance: after stub `task_completed`, next call materializes step 2 only; `cursor` 1→2. 4. halt-on-block: open `decision_blocked` (relatedTaskId) → advances nothing, reports halt; stays halted; unblock → advances. 5. complete-coupling: `complete_task` refused while block open. 6. zero-verdict: negative test — conductor emits no `decision_*`, exposes no approve. 7. keystone: `deriveConductorState` byte-identical after `state/` wipe + re-derive from `events/`. 8. stub determinism: vitest green, mode unset ⇒ no git/cmux touched, no `bindings.ts`, no Postgres.
**Live (user-run):** `BOULE_CONDUCTOR_MODE=live`, accept 2-step plan, `conduct_plan` → real cmux session in isolated worktree with envelope file running `claude`; let it `complete_task` step 1; `conduct_plan` again → step 2; force Type-1 escalation → `pending_escalations` surfaces bound `decision_blocked`, `conduct_plan` halts, only phone `choose` (actor:user) clears it.

## 12. Residual forks (confirm in plan/critic)
(a) in-worktree path-glob = advisory (resolved: structural worktree+verdict isolation, advisory globs — Phase-D/I hardening). (b) who re-invokes conduct = human/Hermes on-demand (no Phase-C auto-trigger). (c) `new-workspace --cwd` vs `new-split`+cd = live-wiring detail, not a design blocker.
