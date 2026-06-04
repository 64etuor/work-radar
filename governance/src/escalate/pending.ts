import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveDecisionState } from "../decision/decision.ts";

export interface PendingOption {
  token: string;
  label: string;
  reply: string;
  description?: string;
}
export interface PendingEscalation {
  decisionId: string;
  blockedEventId: string;
  question: string;
  options: PendingOption[];
  /** The escalating cmux session id, or null for a manual/user escalate. */
  sessionId: string | null;
  agentRecommendation: string | null;
}

/** Read-only: every decision_blocked whose decision is NOT yet terminal (no verdict),
 *  rendered with its bound reply tokens. The Python outbound adapter consumes this so the
 *  token format + resolution logic live only here (SSOT); Python parses no markdown. */
export async function pendingEscalations(
  workspaceDir: string,
  now: Date = new Date(),
): Promise<PendingEscalation[]> {
  const all = await readAllEvents(workspaceDir);
  const out: PendingEscalation[] = [];
  for (const b of all) {
    if (b.frontmatter.type !== "decision_blocked") continue;
    const expires = b.frontmatter.expires;
    if (expires && new Date(expires).getTime() <= now.getTime()) continue; // past TTL → stop re-sending
    const decisionId = (b.frontmatter.related_to ?? [])[0];
    if (!decisionId) continue;
    const grp = eventsForDecision(all, decisionId);
    if (!grp.proposal) continue;
    const state = deriveDecisionState(grp.proposal, grp.related);
    if (state.verdict) continue; // already chosen/approved/rejected → not pending
    let body: { question?: string; options?: PendingOption[]; agent_recommendation?: string | null };
    try {
      body = JSON.parse(b.body);
    } catch {
      continue; // a malformed blocked body is not a routable escalation
    }
    const actor = b.frontmatter.actor as string | undefined;
    out.push({
      decisionId,
      blockedEventId: b.frontmatter.id,
      question: body.question ?? "",
      options: Array.isArray(body.options) ? body.options : [],
      sessionId: actor && actor !== "user" ? actor : null,
      agentRecommendation: body.agent_recommendation ?? null,
    });
  }
  return out;
}
