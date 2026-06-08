---
adr-id: ADR-0010
status: accepted
date: 2026-06-08
decision-makers: [Boule governance track]
tags: [governance, conductor, executor, reviewer, evaluator, backends, budget, routing, automation]
supersedes:
---

# 0010. Autonomous-Coding Backend Selection Policy Engine — Completion Authority, Quorum Chains, Resolver, Budget, Difficulty Routing

## Context and Problem Statement

**Scope**: the Boule governance sidecar (`governance/`) — the conductor's three model roles
(executor / reviewer / evaluator), the per-repo config (`boule.config.json`), and the decision/
task lifecycle. NOT the Tauri app (`src/`, `src-tauri/`).

The live autonomous loop (ADR-0009, master plan L0–L6) closed: a spawned cmux session does work
and the loop advances. But the loop had no **intelligence about which model runs, at what budget,
and who certifies completion**. Three gaps remained for "genuinely autonomous coding":

1. **Completion authority**: the executor session self-certified completion (it called
   `complete_task`, or a shell wrapper did on clean exit). codex's ~60% adherence to that call
   left tasks hung, and self-certification is in tension with INVARIANT #1.
2. **Token-driven model switching** existed only as a CORE (`backends/config.ts` +
   `backends/fallback.ts`) — never wired, and only reactive (token-exhaustion), not proactive.
3. **Difficulty-based model assignment** (OMC-style: cheap model for trivial steps, frontier for
   hard) did not exist at all.

The master plan `governance/docs/plans/2026-06-08-autonomous-coding-master-plan.md` (designed with
a codex 2-brain consult run under a clean `CODEX_HOME` per ADR-0006/the Slice-1 isolation) records
the design. This ADR records the **decisions**, landed as phases M1–M5.

## Decision Drivers

- INVARIANT #1, fail-closed everywhere: no degraded/exhausted/unknown path may open a gate
  (auto-approve / auto-complete / silent-skip). Degradation ⇒ a human-pending terminal
  (executor=stall, reviewer=blocked, evaluator=needs_human).
- "codex 적극 활용": provider switching to codex is a first-class, in-chain option, not a side-door.
- Keep the deterministic core unit-testable; live wiring/smoke stays operator-run.
- No new daemon (INVARIANT #5); structured config travels in-process, not via env round-trips.

## Decisions

**D1 — Single resolver + existing `runWithFallback` (no policy spaghetti).** All model-selection
concerns compose into ONE pure resolver per role, consumed by the existing `runWithFallback`.
Difficulty SELECTS the ideal chain head; budget FILTERS unaffordable candidates **pre-launch**
(a different event from runtime `token_exhausted`, which advances the resolved chain); provider
switch to codex is just a lower-cost rung **inside** the chain. (codex consult: a difficulty→A,
budget→B, fallback→C design is untestable hidden-fallback spaghetti.)

**D2 — Evaluator is the sole completion authority (M1).** The executor session can no longer
self-certify completion. The MCP `complete_task` tool and the codex exit wrapper now emit a
verdict-free `executor_reported_done` HINT; the conductor is the SOLE writer of `task_completed`,
gated on session-terminal + hint + a satisfied per-step `check` contract (deterministic rung). No
`check` / failed check / no hint ⇒ `needs_human` (task stays open). Strengthens INVARIANT #1: the
executor already could not self-APPROVE; now it cannot self-CERTIFY completion either. The
deterministic rung is safe ONLY because it requires an explicit per-step `check` — a generic
"clean exit / non-empty diff" pass would be auto-complete in disguise.

**D3 — Reviewer quorum over fallback chains, counted by ACTUAL responder (M2).** Each quorum member
is a `backends.reviewers[i].chain` run via `runWithFallback`. The decision needs ≥ `reviewQuorum`
**distinct providers/models that actually returned** — a chain that falls back claude→codex counts
as codex, and two backends resolving to the same provider count once (anti-gaming). An exhausted
chain contributes no verdict; fewer than quorum distinct ⇒ stays `decision_blocked`. Budget/fallback
NEVER silently lower the quorum.

**D4 — Pure resolver + difficulty (M3) and budget (M4).** `resolveBackendChain(role, {difficulty},
policy, budget?)` is pure/deterministic. Difficulty→tier head ordering; budget filters via a pure
`BudgetSnapshot` + `PriceTable` (reconstructed from the event journal, not a daemon). Unknown cost
under an active cap ⇒ unaffordable (fail-closed, never free). All candidates unaffordable ⇒ a
role-correct Terminal, never an empty/silent pass. `deterministic` provider is evaluator-only
(`assertProviderAllowed`).

**D5 — Typed difficulty routing (M5).** Planner annotates plan-step `difficulty`; a pure heuristic
infers it when absent. `overrides.routing` is a typed config field (NO untyped cast onto the policy
type — an earlier draft was rejected for `as PolicyWithRouting`). Routing/difficulty are
executor-only; they never lower quorum, never touch acceptance, never make `deterministic` an
executor head.

**D6 — Orchestration toolkit (bootstrap).** `governance/scripts/orchestration/` (gate/run-slice/
new-slice-worktree/merge-slice/commit-if-accepted) offloads the repeatable dev-loop work off the
LLM orchestrator; `commit-if-accepted.sh` refuses to commit without a separate critic ACCEPT
(no-self-approve) and never pushes. This is a bootstrap for `boule tick` (cron-driven, bounded).

## Consequences

- The conductor now has a fail-closed, testable engine for who-runs / at-what-budget / who-certifies.
- Each phase landed with TDD + an independent opus critic pass (author=codex executor, reviewer=
  separate critic — author≠reviewer). Integrated on `plan/autonomous-orchestration`; governance
  vitest 590 → **634**; app bindings/migrations untouched (drift 0).
- INVARIANT #1 risk register (master plan §3, R1–R9) is each pinned by a negative test.

## Deferred (follow-ups, not in M1–M5)

- **Live wiring** of the resolver/budget/difficulty selection into the conductor executor-dispatch
  path, and **live usage recording** into the event journal (budget spend is currently an input).
- **Evaluator LLM rung** beyond the deterministic `check` (the chain is built; the live judge call
  is the next executor wiring).
- **work-radar Settings UI (M6b)** to edit backends/routing/budget (app domain: Rust `boule_config`
  + React + bindings — a separate concern).
- Per-step executor selection beyond run-level; codex network/external-write hardening.
