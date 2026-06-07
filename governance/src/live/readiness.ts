import { evaluatePreflight, type PreflightReport, type PreflightSignals } from "./preflight.ts";
import { parseAutoMode, parseConductorMode, parseObserverMode } from "../mcp/config.ts";

// L4 — Unattended-readiness gate (master plan 2026-06-07, Phase L4).
//
// Preflight (L0) answers "can the live loop PHYSICALLY run, and is the flag posture armed?" with
// the flags ADVISORY. Readiness answers the stricter "is it SAFE to run UNATTENDED right now?" and
// PROMOTES those flags to REQUIRED, plus adds run-state guards (no open stalls). Pure + total.
//
// Why each blocker is load-bearing for unattended operation:
//  - infra (preflight.ready): no cmux/git ⇒ nothing can spawn/isolate.
//  - conductor live: stub adapter spawns nothing — an "unattended run" would be a silent no-op.
//  - observer live: without it, a crashed session is never detected ⇒ a stall is invisible. Running
//    unattended WITHOUT crash detection is the dangerous combination this gate refuses.
//  - auto type2: the only mode that advances steps without a human between them.
//  - no open stalls: a prior crashed-but-in-flight task means the plan is already stuck; piling on
//    more dispatch hides the problem. Resolve first.
//
// NOT re-checked here (already STRUCTURAL, not posture): verdict-tool isolation / forbidden-class
// self-resolution is guaranteed by the executor-role MCP omitting verdict tools (server.ts
// SESSION_ALLOWS_VERDICTS) + decision_blocked halting forever. See ADR-0009.

export interface ReadinessInput {
  /** infra + env signals (same shape preflight consumes). */
  signals: PreflightSignals;
  /** count of currently-stalled tasks (deriveStalledTasks(...).length). */
  stalledCount: number;
}

export interface ReadinessReport {
  /** true ⇔ safe to run unattended (every blocker cleared). */
  ready: boolean;
  /** human-readable blockers; empty ⇔ ready. */
  blockers: string[];
  /** the underlying L0 preflight (infra detail). */
  preflight: PreflightReport;
}

/** Pure, total. Builds on preflight, promotes the live flags to required, and adds the stall guard. */
export function evaluateReadiness(input: ReadinessInput): ReadinessReport {
  const preflight = evaluatePreflight(input.signals);
  const env = input.signals.env;
  const blockers: string[] = [];

  if (!preflight.ready)
    blockers.push("preflight infra not ready (cmux socket/binary or git worktree)");
  if (!parseConductorMode(env.BOULE_CONDUCTOR_MODE))
    blockers.push("BOULE_CONDUCTOR_MODE!=live — no real sessions would spawn");
  if (!parseObserverMode(env.BOULE_OBSERVER_MODE))
    blockers.push("BOULE_OBSERVER_MODE!=live — crashes/stalls undetected (unsafe unattended)");
  if (parseAutoMode(env.BOULE_AUTO_MODE) !== "type2")
    blockers.push("BOULE_AUTO_MODE!=type2 — no unattended step advance");
  if (input.stalledCount > 0)
    blockers.push(`${input.stalledCount} stalled task(s) — resolve before unattended dispatch`);

  return { ready: blockers.length === 0, blockers, preflight };
}
