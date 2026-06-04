import type { ConductorState } from "../../conductor/conductor.ts";

export type AutoMode = "off" | "type2";
export type AutoDenyReason = "mode_off" | "plan_not_accepted" | "halted" | "done" | "in_flight";

export type AutoDispatchVerdict =
  | { decision: "allow"; planId: string; stepIndex: number }
  | { decision: "deny"; planId: string; reason: AutoDenyReason };

const TERMINAL_PLAN_PHASES = new Set(["completed", "archived", "superseded"]);

export function isTerminalPlanPhase(phase: string): boolean {
  return TERMINAL_PLAN_PHASES.has(phase);
}

/** Pure deny-by-default Safety Gate. Order is load-bearing:
 *  mode -> human-accepted plan -> halt -> done -> in-flight. */
export function evaluateAutoDispatch(conductor: ConductorState, mode: AutoMode): AutoDispatchVerdict {
  const planId = conductor.planId;
  if (mode !== "type2") return { decision: "deny", planId, reason: "mode_off" };
  if (conductor.planPhase !== "active") return { decision: "deny", planId, reason: "plan_not_accepted" };
  if (conductor.halted) return { decision: "deny", planId, reason: "halted" };
  if (conductor.done) return { decision: "deny", planId, reason: "done" };
  if (conductor.cursor === null) return { decision: "deny", planId, reason: "in_flight" };
  return { decision: "allow", planId, stepIndex: conductor.cursor };
}
