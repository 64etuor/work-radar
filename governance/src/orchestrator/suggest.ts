import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents } from "../decision/readEvents.ts";
import { projectOrchestratorView } from "./view.ts";
import { evaluateSuggestions } from "./policy.ts";

export interface SuggestSummary {
  created: number;
  skipped: number; // candidates whose (ruleId, subjectId) already had an open suggestion
}

const SEP = " ";
function keyOf(rule: string, subject: string): string {
  return `${rule}${SEP}${subject}`;
}

/** suggest — read events, project the cross-fold view, evaluate advisory rules, and emit AT MOST
 *  ONE orchestrator_suggestion_created per (ruleId, subjectId) not already present in the log
 *  (dedup: no flood; idempotent: run1 emits N, run2 emits 0). This boundary NEVER emits any
 *  decision/task/session event — the ONLY emission type is orchestrator_suggestion_created
 *  (negative test, INVARIANT #1). On-demand: one pass, no poll loop (INVARIANT #5). Mirrors
 *  session/observer.ts (per-emission now + i*1000 offset → distinct chronological ids in one pass). */
export async function suggest(workspaceDir: string, now: Date, rand: number): Promise<SuggestSummary> {
  const all = await readAllEvents(workspaceDir);
  const candidates = evaluateSuggestions(projectOrchestratorView(all));

  const existing = new Set<string>();
  for (const e of all) {
    if (e.frontmatter.type !== "orchestrator_suggestion_created") continue;
    try {
      const b = JSON.parse(e.body) as { rule?: string; subject?: string };
      if (typeof b.rule === "string" && typeof b.subject === "string") existing.add(keyOf(b.rule, b.subject));
    } catch {
      // malformed prior suggestion → ignore for dedup (defensive; suggest only writes canonical JSON)
    }
  }

  const summary: SuggestSummary = { created: 0, skipped: 0 };
  let i = 0;
  for (const c of candidates) {
    const k = keyOf(c.ruleId, c.subjectId);
    if (existing.has(k)) {
      summary.skipped++;
      continue;
    }
    const stamp = new Date(now.getTime() + i * 1000);
    const evt: GovEvent = {
      frontmatter: {
        id: generateId("evt", stamp, rand),
        type: "orchestrator_suggestion_created",
        source: "system",
        actor: "system",
        tags: ["orchestrator", "suggestion"],
        related_to: [c.subjectId],
      },
      body: JSON.stringify({ rule: c.ruleId, subject: c.subjectId, subjectType: c.subjectType, detail: c.detail }),
    };
    await writeEvent(workspaceDir, evt, stamp);
    existing.add(k);
    summary.created++;
    i++;
  }
  return summary;
}
