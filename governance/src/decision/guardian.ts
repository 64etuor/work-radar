import type { DecisionState } from "./decision.ts";

export interface GateDecision {
  ok: boolean;
  reason: string;
}

/** Type 1 Guardian: a decision may be approved ONLY if it has ≥1 external review
 *  and has no terminal verdict yet. This refusal mechanizes INVARIANT #1
 *  ("자동화 → 결정 레일 침투 금지": no Type 1 executes without external verification). */
export function canApprove(s: DecisionState): GateDecision {
  if (s.verdict) return { ok: false, reason: `decision already ${s.verdict}` };
  if (!s.reviewed)
    return { ok: false, reason: "Type 1 decision requires at least one external review before approval" };
  return { ok: true, reason: "reviewed; awaiting human approval" };
}

/** Rejection is allowed at any pre-verdict phase (a human may kill a proposal outright). */
export function canReject(s: DecisionState): GateDecision {
  if (s.verdict) return { ok: false, reason: `decision already ${s.verdict}` };
  return { ok: true, reason: "may be rejected" };
}

/** Human-readable label of the gate currently blocking the decision. */
export function gateLabel(s: DecisionState): string {
  switch (s.phase) {
    case "proposed": return "awaiting external review";
    case "reviewed": return "awaiting human approval";
    case "approved": return "approved";
    case "rejected": return "rejected";
    case "chosen": return "resolved (Type 0 option chosen)";
  }
}
