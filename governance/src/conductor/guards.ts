import type { ConductorState } from "./conductor.ts";

export interface ConductorGate { ok: boolean; reason: string }

/** canAdvance — the conduct precondition, pure over the derived projection.
 *  Refuses (in precedence order):
 *   - plan not active  (human accept_plan is the gate — INVARIANT #1; the Conductor never accepts)
 *   - halted           (an open decision_blocked — NO timeout/default/skip path; resolution needs a human)
 *   - done             (every step materialized + terminal)
 *   - cursor === null   (a prior step is in-flight → wait)
 *  Otherwise ok to materialize exactly the step at `cursor`. */
export function canAdvance(s: ConductorState): ConductorGate {
  if (s.planPhase !== "active") return { ok: false, reason: `plan must be active to conduct (is ${s.planPhase})` };
  if (s.halted) return { ok: false, reason: "halted: an open decision_blocked must be resolved by a human first" };
  if (s.done) return { ok: false, reason: "plan fully conducted (all steps terminal)" };
  if (s.cursor === null) return { ok: false, reason: "a step is in-flight; wait for it to complete" };
  return { ok: true, reason: `advancing step ${s.cursor}` };
}
