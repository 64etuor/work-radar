import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { mintToken } from "./token.ts";

export type AmbiguityKind =
  | "scope"
  | "architecture"
  | "irreversible-design"
  | "security"
  | "product-behavior"
  | "dependency"
  | "data-loss"
  | "cost"
  | "schedule"
  | "unknown";
export type BlockedOn = "human" | "external-review" | "repo-state" | "credential" | "policy";
export type MinimumGate = "none" | "human" | "external-review" | "type1-guardian";

/** Default escalation time-to-live. Past this, pendingEscalations stops surfacing it so the
 *  bridge no longer re-sends — bounded by design (INVARIANT #5). It mints NO terminal event;
 *  the decision stays open in the store and a human can still resolve it directly. */
const DEFAULT_ESCALATION_TTL_HOURS = 72;

export interface EscalateOption {
  label: string;
  /** Optional one-line context shown under the label so a human can decide without
   *  guessing what the bare label means. */
  description?: string;
}
export interface EscalateInput {
  question: string;
  options: EscalateOption[];
  ambiguityKind?: AmbiguityKind;
  blockedOn?: BlockedOn;
  minimumRequiredGate?: MinimumGate;
  agentRecommendation?: string;
  /** The cmux session id when a running session escalates; defaults to "user" for a manual escalate. */
  actor?: string;
  /** Override the escalation TTL (hours). Defaults to DEFAULT_ESCALATION_TTL_HOURS. */
  ttlHours?: number;
  /** v3 Phase C: the task id of a Conductor-spawned session that hits a Type-1 boundary. When set,
   *  the decision_blocked binds BOTH the decisionId AND this taskId in related_to, so Phase-A's
   *  hasOpenBlock + canComplete guard refuses task completion over the open fork (free INVARIANT #1). */
  relatedTaskId?: string;
}

export interface EscalateOptionOut {
  token: string;
  label: string;
  reply: string;
  description?: string;
}
export interface EscalateResult {
  decisionId: string; // evt_* id of the Type 0 decision_proposed
  blockedEventId: string; // evt_* id of the decision_blocked event
  options: EscalateOptionOut[];
}

/** /escalate — emit a Type 0 escalation: a decision_proposed (phase=proposed, verdict=null IS
 *  Type 0 "pending") + a decision_blocked carrying the discrete options. Returns the structured
 *  payload (a-prime: the bridge acts on the return; no daemon). Append-only; mints NO verdict. */
export async function escalate(
  workspaceDir: string,
  input: EscalateInput,
  now: Date,
  rand: number,
): Promise<EscalateResult> {
  if (input.options.length < 2) throw new Error("escalate requires at least two options");
  if (!input.question.trim()) throw new Error("escalate requires a non-empty question");
  if (input.options.some((o) => !o.label.trim()))
    throw new Error("escalate requires a non-empty label for every option");
  const actor = input.actor ?? "user";
  const source = actor === "user" ? "hermes" : "agent_run";

  // 1) Type 0 decision_proposed — proposed + verdict:null is exactly "Type 0 / pending".
  const proposal: GovEvent = {
    frontmatter: { id: generateId("evt", now, rand), type: "decision_proposed", source, actor, tags: ["decision", "type0"] },
    body: input.question,
  };
  await writeEvent(workspaceDir, proposal, now);
  const decisionId = proposal.frontmatter.id;

  // 2) decision_blocked — distinct id (offset stamp avoids a same-second collision), one
  //    fully-bound token per option. The token binds the reply to BOTH event ids.
  const blockedNow = new Date(now.getTime() + 1000);
  const blockedId = generateId("evt", blockedNow, rand);
  const ttlHours = input.ttlHours ?? DEFAULT_ESCALATION_TTL_HOURS;
  const expires = new Date(blockedNow.getTime() + ttlHours * 3_600_000).toISOString();
  const options: EscalateOptionOut[] = input.options.map((o, i) => {
    const optionToken = `opt${i}`;
    return {
      token: optionToken,
      label: o.label,
      reply: mintToken(blockedId, decisionId, optionToken),
      description: o.description,
    };
  });
  const blocked: GovEvent = {
    frontmatter: {
      id: blockedId,
      type: "decision_blocked",
      source,
      actor,
      expires,
      // related_to binds the decision and, when a Conductor-spawned session escalates, ALSO the
      // task — so Phase-A canComplete refuses to complete that task over the open block.
      related_to: input.relatedTaskId ? [decisionId, input.relatedTaskId] : [decisionId],
      tags: [
        "escalation",
        `ambiguity:${input.ambiguityKind ?? "unknown"}`,
        `blocked_on:${input.blockedOn ?? "human"}`,
        `min_gate:${input.minimumRequiredGate ?? "human"}`,
      ],
    },
    body: JSON.stringify(
      {
        question: input.question,
        options: options.map((o) => ({ token: o.token, label: o.label, reply: o.reply, description: o.description })),
        agent_recommendation: input.agentRecommendation ?? null,
      },
      null,
      2,
    ),
  };
  await writeEvent(workspaceDir, blocked, blockedNow);

  return { decisionId, blockedEventId: blockedId, options };
}
