import type { PlanState } from "./plan.ts";

export interface PlanGate { ok: boolean; reason: string; }

/** Accept is the HUMAN GATE: allowed from draft (first acceptance) or needs_revision
 *  (accepting a revision). The handler hard-codes actor:"user" — the Planner that proposed
 *  the plan has no tool that reaches this transition (structural INVARIANT #1). */
export function canAccept(s: PlanState): PlanGate {
  if (s.verdict) return { ok: false, reason: `plan already ${s.verdict}` };
  if (s.phase === "active") return { ok: false, reason: "plan already active" };
  return { ok: true, reason: s.phase === "needs_revision" ? "accepting revision" : "accepting" };
}

/** Revise is allowed ONLY from active (active ──revise──▶ needs_revision). */
export function canRevise(s: PlanState): PlanGate {
  if (s.verdict) return { ok: false, reason: `plan already ${s.verdict}` };
  if (s.phase !== "active") return { ok: false, reason: `plan must be active to revise (is ${s.phase})` };
  return { ok: true, reason: "revising" };
}

/** Complete is allowed ONLY from active. */
export function canComplete(s: PlanState): PlanGate {
  if (s.verdict) return { ok: false, reason: `plan already ${s.verdict}` };
  if (s.phase !== "active") return { ok: false, reason: `plan must be active to complete (is ${s.phase})` };
  return { ok: true, reason: "completing" };
}

/** Archive is allowed at any non-terminal phase. */
export function canArchive(s: PlanState): PlanGate {
  if (s.verdict) return { ok: false, reason: `plan already ${s.verdict}` };
  return { ok: true, reason: "archiving" };
}

/** Supersede is allowed at any non-terminal phase (a newer plan replaces this one). */
export function canSupersede(s: PlanState): PlanGate {
  if (s.verdict) return { ok: false, reason: `plan already ${s.verdict}` };
  return { ok: true, reason: "superseding" };
}
