import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision, proposalsOf } from "./readEvents.ts";
import { deriveDecisionState, type DecisionState } from "./decision.ts";
import { canApprove, canReject, gateLabel } from "./guardian.ts";
import { recordReview, type RecordReviewResult, type ReviewerEntry, type RequestReviewResult, type ReviewFailure, type ReviewSkip } from "./reviewer.ts";
import { normalizeModelId } from "./modelId.ts";

export interface ProposeInput { title: string; body: string; }
export interface ProposeResult { id: string; path: string; }

/** /propose_decision — write a Type 1 decision_proposed L0 event. Body = "title\n\nbody". */
export async function proposeDecision(
  workspaceDir: string, input: ProposeInput, now: Date, rand: number,
): Promise<ProposeResult> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "decision_proposed",
      source: "hermes",
      actor: "user",
      tags: ["decision", "type1"],
    },
    body: input.body ? `${input.title}\n\n${input.body}` : input.title,
  };
  const path = await writeEvent(workspaceDir, evt, now);
  return { id: evt.frontmatter.id, path };
}

async function loadState(
  workspaceDir: string,
  decisionId: string,
  quorum = 1,
): Promise<{ state: DecisionState; proposal: GovEvent }> {
  const grp = eventsForDecision(await readAllEvents(workspaceDir), decisionId);
  if (!grp.proposal) throw new Error(`unknown decision: ${decisionId}`);
  return { state: deriveDecisionState(grp.proposal, grp.related, quorum), proposal: grp.proposal };
}

export interface ReviewInput { decisionId: string; authorModel: string; }

/** /request_review — run a batch of External Reviewers (one per distinct model) for a
 *  decision. Records each success as a linked review event; a reviewer equal to the author
 *  is SKIPPED, a reviewer whose bounded retry is exhausted is reported as a FAILURE — the
 *  batch never aborts. The quorum/distinct-model gate (deriveDecisionState) decides whether
 *  enough independent models reviewed. now is offset per reviewer to keep event ids/files
 *  unique (writeEvent is fail-if-exists at second resolution). */
export async function requestReview(
  workspaceDir: string,
  input: ReviewInput,
  reviewers: ReviewerEntry[],
  now: Date,
  rand: number,
): Promise<RequestReviewResult> {
  const { state, proposal } = await loadState(workspaceDir, input.decisionId);
  if (state.verdict) throw new Error(`decision already ${state.verdict}; cannot review`);

  const recorded: RecordReviewResult[] = [];
  const failures: ReviewFailure[] = [];
  const skipped: ReviewSkip[] = [];

  for (let i = 0; i < reviewers.length; i++) {
    const { model, fn } = reviewers[i];
    // pre-skip a reviewer that is the same model as the author (different-model invariant)
    if (normalizeModelId(model) === normalizeModelId(input.authorModel)) {
      skipped.push({ reviewerModel: model, reason: "same model as author" });
      continue;
    }
    const at = new Date(now.getTime() + i * 1000); // unique stamp within a batch → unique id + filename; a cross-batch same-second collision is fail-safe (writeEvent uses wx → surfaces as a caught failure, not corruption)
    try {
      const r = await recordReview(
        workspaceDir,
        { decisionId: input.decisionId, title: state.title, proposalBody: proposal.body, authorModel: input.authorModel },
        fn, at, rand,
      );
      recorded.push(r);
    } catch (err) {
      failures.push({ reviewerModel: model, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { recorded, failures, skipped };
}

export interface GateResult { ok: boolean; reason: string; eventId?: string; }

/** /approve <id> — human gate. Guarded: refuses unless reviewed and un-terminated. */
export async function approve(
  workspaceDir: string,
  input: { decisionId: string },
  now: Date,
  rand: number,
  quorum = 1,
): Promise<GateResult> {
  const { state } = await loadState(workspaceDir, input.decisionId, quorum);
  const gate = canApprove(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "decision_approved", source: "hermes", actor: "user",
      tags: ["decision", "approval"], related_to: [input.decisionId],
    },
    body: `Human approved ${input.decisionId}`,
  };
  await writeEvent(workspaceDir, evt, now);
  return { ok: true, reason: gate.reason, eventId: evt.frontmatter.id };
}

/** /reject <id> — human gate (negative). */
export async function reject(workspaceDir: string, input: { decisionId: string }, now: Date, rand: number): Promise<GateResult> {
  const { state } = await loadState(workspaceDir, input.decisionId);
  const gate = canReject(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "decision_rejected", source: "hermes", actor: "user",
      tags: ["decision", "rejection"], related_to: [input.decisionId],
    },
    body: `Human rejected ${input.decisionId}`,
  };
  await writeEvent(workspaceDir, evt, now);
  return { ok: true, reason: gate.reason, eventId: evt.frontmatter.id };
}

export interface PendingDecision { decisionId: string; title: string; phase: DecisionState["phase"]; gate: string; }

/** /conflicts — decisions still awaiting a gate (proposed = needs review, reviewed = needs human). */
export async function conflicts(workspaceDir: string, quorum = 1): Promise<PendingDecision[]> {
  const all = await readAllEvents(workspaceDir);
  const out: PendingDecision[] = [];
  for (const proposal of proposalsOf(all)) {
    const grp = eventsForDecision(all, proposal.frontmatter.id);
    const s = deriveDecisionState(proposal, grp.related, quorum);
    if (s.phase === "proposed" || s.phase === "reviewed") {
      out.push({ decisionId: s.decisionId, title: s.title, phase: s.phase, gate: gateLabel(s) });
    }
  }
  return out;
}

export interface TrailEntry { id: string; type: GovEvent["frontmatter"]["type"]; actor: string; summary: string; }
export interface DecisionTrail { decisionId: string; title: string; phase: DecisionState["phase"]; chain: TrailEntry[]; }

/** /why <id> and /history <id> — the full chronological audit trail of a decision. */
export async function why(
  workspaceDir: string,
  input: { decisionId: string },
  quorum = 1,
): Promise<DecisionTrail> {
  const grp = eventsForDecision(await readAllEvents(workspaceDir), input.decisionId);
  if (!grp.proposal) throw new Error(`unknown decision: ${input.decisionId}`);
  const s = deriveDecisionState(grp.proposal, grp.related, quorum);
  const chain: TrailEntry[] = [grp.proposal, ...grp.related].map((e) => ({
    id: e.frontmatter.id, type: e.frontmatter.type, actor: e.frontmatter.actor,
    summary: e.body.split("\n", 1)[0] ?? "",
  }));
  return { decisionId: s.decisionId, title: s.title, phase: s.phase, chain };
}

/** /history — alias of why (same trail). Kept distinct for command-surface parity. */
export const history = why;
