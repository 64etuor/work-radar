import type { HandoffState } from "./handoff.ts";

export interface Gate { ok: boolean; reason: string; }
const ok: Gate = { ok: true, reason: "" };

/** draft allowed only from `requested` (first draft) or `invalid` (re-draft). */
export function canDraft(s: HandoffState): Gate {
  return s.phase === "requested" || s.phase === "invalid"
    ? ok
    : { ok: false, reason: `cannot draft a handoff in phase ${s.phase}` };
}

/** validate allowed only from `validating` (a draft is awaiting the structural check). */
export function canValidate(s: HandoffState): Gate {
  return s.phase === "validating"
    ? ok
    : { ok: false, reason: `no draft awaiting validation (phase ${s.phase})` };
}

/** consume (hydrate) allowed only from `pending` (validated, not yet consumed). */
export function canConsume(s: HandoffState): Gate {
  return s.phase === "pending"
    ? ok
    : { ok: false, reason: `cannot consume a handoff in phase ${s.phase}` };
}
