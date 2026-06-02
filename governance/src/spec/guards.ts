import type { SpecState } from "./spec.ts";

export interface SpecGate { ok: boolean; reason: string; }

/** Accept is the HUMAN GATE: allowed ONLY from draft → accepted. The handler hard-codes
 *  actor:"user" — the author that proposed the spec has no tool that reaches this
 *  transition (structural INVARIANT #1). */
export function canAccept(s: SpecState): SpecGate {
  if (s.verdict) return { ok: false, reason: `spec already ${s.verdict}` };
  if (s.phase === "accepted") return { ok: false, reason: "spec already accepted" };
  return { ok: true, reason: "accepting" };
}

/** Archive is allowed at any non-terminal phase (draft or accepted → archived). */
export function canArchive(s: SpecState): SpecGate {
  if (s.verdict) return { ok: false, reason: `spec already ${s.verdict}` };
  return { ok: true, reason: "archiving" };
}
