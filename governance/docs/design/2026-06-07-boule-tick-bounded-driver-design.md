# `boule tick` — bounded auto-dispatch driver (design, for confirmation)

- **Date**: 2026-06-07
- **Status**: ✅ BUILT 2026-06-07 (`boule tick` shipped; codex-consulted, live-proven). §6 resolved below.
- **Author**: claude (Opus), from the user's framing; design decisions consulted with codex (`codex exec`).
- **Related**: master plan `governance/docs/plans/2026-06-07-boule-v3-live-autonomy-master-plan.md` (L2 auto_dispatch, L4 readiness); per-repo spec `governance/docs/design/2026-06-07-per-repo-governance-mcp-design.md`; runbook `governance/docs/runbooks/2026-06-07-live-loop-smoke.md`.

## 0. One line

`boule tick` is the **external heartbeat** that advances an already-accepted plan by **at most N bounded transitions per invocation**, then exits. Persistence is the external scheduler's job; autonomy is capped to bounded transitions; **irreversibility and stall recovery stay human**.

> `auto_dispatch` = the engine (one bounded transition). `boule tick` = one heartbeat (drive the engine ≤N times, safely). The external cron/operator = the clock. The brain (Type-1 decisions, stall recovery, principle changes) is **never** taken from the human.

## 1. Why (and why NOT a daemon)

The loop is event-sourced and on-demand by design (INVARIANT #5: no daemon/poll loop). Today nothing drives `auto_dispatch` continuously — an operator/driver must call it. `boule tick` is the **minimal, bounded** bridge to "multi-time-scale agents" (plan Phase 3) WITHOUT introducing a daemon:

- ❌ internal daemon / `setInterval` / `while(true)` / sleep-poll
- ❌ automating spec/plan **acceptance**
- ❌ automatic **stall recovery**
- ❌ automatic **Type-1** resolution/approval
- ✅ external scheduler gives the cadence; each tick is a single bounded synchronous pass

## 2. Command surface

```
boule tick --repo <path> [--max-steps N] [--json]
```

- Resolves the repo's policy + env exactly like `boule run` (`repoEnv` → `BOULE_WORKSPACE/REPO_ROOT/WORKTREES_ROOT` + policy). Conductor/observer live flags come from env/operator (e.g. `BOULE_CONDUCTOR_MODE=live`), same as `boule run`.
- `--max-steps N`: hard cap on conducts **this invocation**. Default **1**. Clamped to a bounded ceiling (e.g. `1..=BOULE_TICK_MAX` default ceiling 10) — never unbounded.
- `--json`: machine-readable report for cron logs.
- **Exit codes**: `0` advanced or idle-nothing-ready; `0` (or a distinct code) blocked/halted/stalled — TBD (see §6 open questions). Non-zero only on infra failure (preflight/readiness hard-fail).

## 3. Behavior (one tick = one synchronous bounded pass)

```
1. preflight + readiness (L0/L4): if infra not ready (cmux/git/worktree) OR
   readiness=false (observer not live, open stalls) → REPORT + exit, conduct 0.
2. recompute projections from events (deriveConductorState / projectTasks / stall).
3. detect blocking state:
     - any plan halted (open decision_blocked) → REPORT + exit (no advance past it).
     - stalled_tasks non-empty → REPORT + exit (human must re-dispatch/recover).
4. if runnable: call auto_dispatch (conducts ≤1 ready step per active plan in its pass),
   accumulate up to --max-steps conducts. Each conduct mints task_*/step_bound/
   session_spawned events (auto_dispatch already writes every transition).
5. exit with a structured report (conducted, skipped/in-flight, halted, stalled, idle).
```

**No waiting.** A tick does NOT block for a spawned session to finish (no sleep loop — that would be an internal poll). It conducts whatever is **ready right now** and exits. A conducted session completes **asynchronously between ticks**; the **next** tick observes `task_completed` (via the event log) and conducts the next ready step.

⇒ The **cron interval IS the polling period** for "is the next step ready yet" — the poll lives **outside** the process (the scheduler), so INVARIANT #5 holds. Realistically a tick conducts **at most 1 new step per plan** (subsequent steps aren't ready until the prior session completes), so `--max-steps>1` only matters across **multiple independent ready plans**.

## 4. External cadence (the heartbeat lives outside)

```
*/30 * * * *  cd /repo && boule tick --repo /repo --max-steps 1 --json >> .boule/tick.log 2>&1
```

The scheduler (cron / launchd / operator / a Phase-3 time-scale agent) owns persistence + cadence. Different repos/kinds can tick at different intervals (the "multi-time-scale" idea) — all without a daemon.

## 5. INVARIANT mapping

| #                                               | How `tick` honors it                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **#1** automation must not cross decision rails | tick **stops** at halted/decision*blocked; never `choose`/`approve`/`accept*_`; only calls `auto*dispatch`(verdict-free, writes no`decision*_`). |
| **#5** bounded retry / no daemon                | each tick = one synchronous bounded pass (≤max_steps, hard ceiling), no sleep/poll/loop; cadence is external.                                    |
| L4 readiness                                    | tick gates on `evaluateReadiness` (preflight infra + observer-live + no open stalls) before conducting.                                          |
| stall safety (L2-C)                             | `stalled_tasks` non-empty ⇒ tick reports + refuses to advance (recovery is human).                                                               |

## 6. RESOLVED (codex consult 2026-06-07 — agreed all 5 leans + added 2 refinements)

As built: **1** no tick event (cron log + transition events only). **2** exit codes `0` advanced/idle/in_flight · `10` halted/stalled (page a human) · `1` readiness/infra failed. **3** require full L4 readiness (observer live; no degraded tick). **4** total `--max-steps` cap across all plans, **enforced UNDER the dispatch boundary** (codex: don't loop around an unbounded pass) — `autoDispatch` gained a `maxConducts` param. **5** `boule tick` CLI subcommand reusing `autoAccept`/`evaluateReadiness`/`listStalledTasks`/`autoDispatch` in-process (no MCP). **Codex refinement (adopted):** a structured `TickReport` with stable reason categories — `advanced`/`idle`/`in_flight`/`halted_decision`/`stalled`/`readiness_failed`/`infra_failed` — a contract for cron/dashboards/tests, NOT events. Codex confirmed the "no-waiting / cron=poll-period" model is sound and INVARIANT #1/#5 hold (no sleep loop + hard ceiling; halt on decision_blocked/stall; reuse existing auto-accept audit semantics, no new acceptance path). Live-proven: readiness gate (observer-off → readiness_failed exit 1), seeded plan → advanced (auto-accepted spec+plan at full), 2nd tick → in_flight (session still running, no re-conduct).

**Post-review fixes (codex critic, ACCEPT-WITH-RESERVATIONS → resolved):** `in_flight` now means an
actually-RUNNING step (a materialized task in `active` phase via `projectTasks`), NOT merely a
non-terminal plan — so an unaccepted **draft** (at dispatch) or a **needs_revision** plan correctly
reports **`idle`** (it's the human's turn to accept/revise; not alert-worthy, exit 0), not a false
`in_flight`. The not-ready outcome is categorized structurally from `stalledCount` + `preflight.ready`
(no blocker-string regex), and `stalledCount` is threaded into the tick (no double read). Tests now
pin `in_flight` (running task) and `idle` (unaccepted draft).

### Original open questions (for the record)

1. **Tick audit event?** Should each tick emit a single `tick_ran` audit event (cadence visibility in the SSOT), or stay write-delegating (only `auto_dispatch`'s transition events, no tick noise)? _Lean: no tick event by default; rely on the cron log + the transition events. Optional `--audit` to emit one._
2. **Exit code semantics** for blocked/stalled — `0` (normal, "nothing to do") vs a distinct non-zero so cron alerting can page a human on a stuck plan. _Lean: `0` for idle/advanced; distinct code (e.g. `10`) for halted/stalled so an operator alert can fire — without that, a stuck plan is silent._
3. **Readiness strictness**: require `BOULE_OBSERVER_MODE=live` (full L4) for any tick, or allow a "conduct-only, no stall-safety" degraded tick when the observer isn't armed? _Lean: require readiness (fail-closed); a degraded tick risks silent stalls._
4. **Scope of one tick across plans**: cap `--max-steps` total across all active plans (simpler) vs per-plan. _Lean: total cap._
5. **Where it lives**: a `tick` subcommand in `src/cli/boule.ts` (peer of `run`), reusing `autoDispatch` + `evaluateReadiness` + `listStalledTasks` directly (no MCP round-trip needed since it's in-process). _Lean: yes — `boule tick` in the CLI, pure-core reuse._

## 7. Build plan (after confirmation)

1. `tick` core (pure-ish): given workspace+repo env → {readiness, halted, stalled, conductable} → conduct ≤max_steps via `autoDispatch` → structured report. Unit-tested with the stub conductor (deterministic, no cmux).
2. `boule tick` CLI wiring (peer of `run`), arg parse + clamp + `--json`.
3. Live smoke (runbook §6): cron-style repeated `boule tick --max-steps 1` advances a 2-step plan across ticks; halts at an injected `decision_blocked`; refuses on an injected stall.
4. Docs: runbook §6 (operator cron setup) + plan as-built + ADR if the autonomy posture needs one (tick is bounded + gated, so likely a `decisions.md` line, not a new ADR — confirm).
