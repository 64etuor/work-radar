/** Opaque, single-use, fully-bound governance option token.
 *  Format: BOULE:<blockedEventId>:<decisionId>:<optionToken>
 *  Matched by EXACT equality only — never substring/keyword. The WORKLOG inbound-routing
 *  bug-class is precisely substring routing; do not reintroduce it. */
const PREFIX = "BOULE";
const SEP = ":";

export interface ParsedToken {
  blockedEventId: string;
  decisionId: string;
  optionToken: string;
}

export function mintToken(blockedEventId: string, decisionId: string, optionToken: string): string {
  return [PREFIX, blockedEventId, decisionId, optionToken].join(SEP);
}

/** Parse a candidate reply. Returns null unless it is a well-formed token: exactly four
 *  colon-separated fields, correct prefix, no empty field. A BOULE-prefixed-but-malformed
 *  string also returns null — the caller consumes/rejects it, never forwards it to the pane.
 *  (Event ids are `evt_*` and contain no colon, so a 4-field split is unambiguous.) */
export function parseToken(text: string): ParsedToken | null {
  const parts = text.trim().split(SEP);
  if (parts.length !== 4) return null;
  const [prefix, blockedEventId, decisionId, optionToken] = parts;
  if (prefix !== PREFIX) return null;
  if (!blockedEventId || !decisionId || !optionToken) return null;
  return { blockedEventId, decisionId, optionToken };
}

/** True iff `text` looks like a governance reply (BOULE-prefixed), even if malformed.
 *  The inbound interceptor uses this to choose "consume/reject" vs "fall through to a
 *  normal pane steer". */
export function isGovernanceReply(text: string): boolean {
  return text.trim().startsWith(PREFIX + SEP);
}
