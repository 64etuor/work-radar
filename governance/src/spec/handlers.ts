import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveSpecState, specsOf, type SpecState } from "./spec.ts";
import { canAccept, canArchive } from "./guards.ts";

export interface SpecGateResult { ok: boolean; reason: string; eventId?: string; }

async function loadSpec(workspaceDir: string, specId: string): Promise<{ state: SpecState; all: GovEvent[] }> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, specId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "spec_proposed")
    throw new Error(`unknown spec: ${specId}`);
  return { state: deriveSpecState(grp.proposal, grp.related), all };
}

/** A human-gated lifecycle write: every non-propose transition is actor:"user". Mirrors
 *  plan/handlers writeLifecycle. */
async function writeLifecycle(
  workspaceDir: string, type: EventType, specId: string, body: string, now: Date, rand: number,
): Promise<string> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type, source: "hermes", actor: "user",
      tags: ["spec"], related_to: [specId],
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return evt.frontmatter.id;
}

export interface ProposeSpecInput { title: string; summary: string; }
export interface ProposeSpecResult { specId: string; }

/** Author — drafts a spec, emits EXACTLY ONE spec_proposed (draft). actor:"author" (NOT a
 *  human gate, NOT a verdict). This is the ONLY write path here; there is no acceptance path,
 *  so the author cannot accept its own spec (structural INVARIANT #1). Spec CONTENT lives in
 *  markdown; the event body carries only a title + denormalized summary label. */
export async function proposeSpec(
  workspaceDir: string, input: ProposeSpecInput, now: Date, rand: number,
): Promise<ProposeSpecResult> {
  const title = input.title?.trim();
  if (!title) throw new Error("spec title must be non-empty");
  const summary = (input.summary ?? "").trim();
  const body = summary ? `${title}\n\n${summary}` : title;
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "spec_proposed", source: "hermes", actor: "author",
      tags: ["spec"],
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return { specId: evt.frontmatter.id };
}

/** accept_spec — HUMAN GATE: draft → accepted (actor:"user"). */
export async function acceptSpec(workspaceDir: string, input: { specId: string }, now: Date, rand: number): Promise<SpecGateResult> {
  const { state } = await loadSpec(workspaceDir, input.specId);
  const gate = canAccept(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "spec_accepted", input.specId, `Accepted ${input.specId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** archive_spec — any non-terminal → archived (terminal). */
export async function archiveSpec(workspaceDir: string, input: { specId: string }, now: Date, rand: number): Promise<SpecGateResult> {
  const { state } = await loadSpec(workspaceDir, input.specId);
  const gate = canArchive(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "spec_archived", input.specId, `Archived ${input.specId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

export interface SpecSummary { specId: string; title: string; phase: SpecState["phase"]; }

/** specs — non-archived specs (draft + accepted). */
export async function listSpecs(workspaceDir: string): Promise<SpecSummary[]> {
  const all = await readAllEvents(workspaceDir);
  const out: SpecSummary[] = [];
  for (const sp of specsOf(all)) {
    const grp = eventsForDecision(all, sp.frontmatter.id);
    const s = deriveSpecState(grp.proposal!, grp.related);
    if (s.verdict === null) out.push({ specId: s.specId, title: s.title, phase: s.phase });
  }
  return out;
}

export interface SpecTrailEntry { id: string; type: GovEvent["frontmatter"]["type"]; actor: string; summary: string; }
export interface SpecTrail { specId: string; title: string; phase: SpecState["phase"]; plans: string[]; chain: SpecTrailEntry[]; }

/** spec <id> — full chronological trail. */
export async function specTrail(workspaceDir: string, input: { specId: string }): Promise<SpecTrail> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, input.specId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "spec_proposed") throw new Error(`unknown spec: ${input.specId}`);
  const s = deriveSpecState(grp.proposal, grp.related);
  const specRelated = grp.related.filter((e) => e.frontmatter.type.startsWith("spec_"));
  const chain: SpecTrailEntry[] = [grp.proposal, ...specRelated].map((e) => ({
    id: e.frontmatter.id, type: e.frontmatter.type, actor: e.frontmatter.actor,
    summary: e.body.split("\n", 1)[0] ?? "",
  }));
  const plans = all
    .filter((e) => e.frontmatter.type === "plan_proposed" && (e.frontmatter.related_to ?? []).includes(input.specId))
    .map((e) => e.frontmatter.id)
    .sort((a, b) => a.localeCompare(b));
  return { specId: s.specId, title: s.title, phase: s.phase, plans, chain };
}
