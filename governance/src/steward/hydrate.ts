import type { GovEvent } from "../event/event.ts";
import type { HandoffState } from "../handoff/handoff.ts";

export interface GitSummary { status: string; diffstat: string; }
export interface IndexNeighbor { node_id: string; title: string; }
export interface OpenBlocker { decisionId: string; blockedEventId: string; summary: string; }

/** Inputs to the PURE hydration assembler — all already read by the IO shell (no I/O here). */
export interface AssembleInputs {
  handoff: HandoffState;
  handoffBody: string;       // the latest validated draft body (the 7 sections)
  log: GovEvent[];           // for recent events + open blockers
  principles: string[];      // from the Phase 3 index ingress
  spec: string;              // derived/selected upstream
  activePlan: string;
  currentTask: string;
  indexNeighbors: IndexNeighbor[]; // 1-hop from the Phase F graph index
  gitSummary: GitSummary;
  autonomyEnvelope: string;  // carried from the handoff/session — NOT expandable
}

/** The continuity payload a fresh session consumes. NOTE: there is intentionally NO field that
 *  grants/approves/allows authority — the bundle informs, it does not empower (laundering ban §4.4#5). */
export interface HydrationBundle {
  roleTemplate: string;
  principles: string[];
  spec: string;
  activePlan: string;
  currentTask: string;
  latestHandoff: string;
  recentEvents: { id: string; type: string }[];
  gitSummary: GitSummary;
  knownRisks: string[];
  nextExactSteps: string;
  openBlockers: OpenBlocker[]; // unresolved decision_blocked — MUST survive into the new session
  autonomyEnvelope: string;
}

const RECENT_N = 20;

function openBlockers(log: GovEvent[]): OpenBlocker[] {
  const VERDICTS = new Set(["decision_approved", "decision_rejected", "decision_chosen"]);
  const resolved = new Set(
    log.filter((e) => VERDICTS.has(e.frontmatter.type)).flatMap((e) => e.frontmatter.related_to ?? []),
  );
  const out: OpenBlocker[] = [];
  for (const e of log) {
    if (e.frontmatter.type !== "decision_blocked") continue;
    const refs = e.frontmatter.related_to ?? [];
    if (refs.some((r) => resolved.has(r))) continue;
    out.push({
      decisionId: refs[0] ?? e.frontmatter.id,
      blockedEventId: e.frontmatter.id,
      summary: e.body.split("\n", 1)[0] ?? "",
    });
  }
  return out;
}

/** Extract a named markdown section's content from the handoff body (best-effort; "" if absent). */
function sectionContent(body: string, name: string): string {
  const lines = body.split("\n");
  let capture = false;
  const out: string[] = [];
  for (const line of lines) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) { capture = m[1].toLowerCase().startsWith(name.toLowerCase()); continue; }
    if (capture) out.push(line);
  }
  return out.join("\n").trim();
}

/** PURE: assemble the hydration bundle + a deterministic markdown render. No I/O. */
export function assembleBundle(inp: AssembleInputs): { bundle: HydrationBundle; markdown: string } {
  const recentEvents = inp.log
    .slice(-RECENT_N)
    .map((e) => ({ id: e.frontmatter.id, type: e.frontmatter.type }));
  const knownRisksText = sectionContent(inp.handoffBody, "Do not do");
  const bundle: HydrationBundle = {
    roleTemplate: "Resume the in-flight task. Preserve all open blockers; do not expand authority.",
    principles: inp.principles,
    spec: inp.spec,
    activePlan: inp.activePlan,
    currentTask: inp.currentTask,
    latestHandoff: inp.handoffBody,
    recentEvents,
    gitSummary: inp.gitSummary,
    knownRisks: knownRisksText ? knownRisksText.split("\n").filter((l) => l.trim()) : [],
    nextExactSteps: sectionContent(inp.handoffBody, "Next exact steps"),
    openBlockers: openBlockers(inp.log),
    autonomyEnvelope: inp.autonomyEnvelope,
  };

  const md = [
    "# Hydration Bundle",
    `\n## Role\n${bundle.roleTemplate}`,
    `\n## Autonomy envelope\n${bundle.autonomyEnvelope}`,
    `\n## Principles\n${bundle.principles.map((p) => `- ${p}`).join("\n") || "(none)"}`,
    `\n## Spec\n${bundle.spec}`,
    `\n## Active plan\n${bundle.activePlan}`,
    `\n## Current task\n${bundle.currentTask}`,
    `\n## Open blockers (MUST resolve via human gate — do not assume)\n${bundle.openBlockers.map((b) => `- ${b.decisionId}: ${b.summary}`).join("\n") || "(none)"}`,
    `\n## Next exact steps\n${bundle.nextExactSteps}`,
    `\n## Known risks (do not do)\n${bundle.knownRisks.map((r) => `- ${r}`).join("\n") || "(none)"}`,
    `\n## Git\n${bundle.gitSummary.status}\n${bundle.gitSummary.diffstat}`,
    `\n## Recent events\n${bundle.recentEvents.map((e) => `- ${e.id} ${e.type}`).join("\n") || "(none)"}`,
  ].join("\n");

  return { bundle, markdown: md };
}
