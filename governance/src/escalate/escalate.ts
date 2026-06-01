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

export interface EscalateOption {
  label: string;
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
}

export interface EscalateOptionOut {
  token: string;
  label: string;
  reply: string;
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
  const options: EscalateOptionOut[] = input.options.map((o, i) => {
    const optionToken = `opt${i}`;
    return { token: optionToken, label: o.label, reply: mintToken(blockedId, decisionId, optionToken) };
  });
  const blocked: GovEvent = {
    frontmatter: {
      id: blockedId,
      type: "decision_blocked",
      source,
      actor,
      related_to: [decisionId],
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
        options: options.map((o) => ({ token: o.token, label: o.label, reply: o.reply })),
        agent_recommendation: input.agentRecommendation ?? null,
      },
      null,
      2,
    ),
  };
  await writeEvent(workspaceDir, blocked, blockedNow);

  return { decisionId, blockedEventId: blockedId, options };
}
