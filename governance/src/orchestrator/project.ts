import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAllEvents } from "../decision/readEvents.ts";
import { projectOrchestratorView } from "./view.ts";

export interface OpenSuggestion {
  id: string;
  rule: string;
  subject: string;
  subjectType: string;
  detail: string;
}

/** Render the derived cross-fold view to state/orchestrator-view.json. Overwrites; fully
 *  rebuildable from events; deterministic field + element order yields byte-stable output (keystone
 *  property test). This writer holds NO authority — it only projects existing folds. */
export async function renderOrchestrator(workspaceDir: string): Promise<string> {
  const view = projectOrchestratorView(await readAllEvents(workspaceDir));
  const stateDir = join(workspaceDir, "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "orchestrator-view.json");
  const rows = {
    tasks: view.tasks.map((t) => ({ taskId: t.state.taskId, phase: t.state.phase, hasOpenBlock: t.hasOpenBlock })),
    plans: view.plans.map((p) => ({ planId: p.planId, phase: p.phase })),
    sessions: view.sessions.map((s) => ({ sessionId: s.sessionId, phase: s.phase, ownership: s.ownership, taskId: s.taskId })),
  };
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
  return path;
}

/** Open suggestions = all orchestrator_suggestion_created events. In this slice there is no
 *  dismiss/acknowledge event, so every emitted suggestion is open (sorted by id). */
export async function listSuggestions(workspaceDir: string): Promise<OpenSuggestion[]> {
  const all = await readAllEvents(workspaceDir);
  const out: OpenSuggestion[] = [];
  for (const e of all) {
    if (e.frontmatter.type !== "orchestrator_suggestion_created") continue;
    try {
      const b = JSON.parse(e.body) as { rule?: string; subject?: string; subjectType?: string; detail?: string };
      out.push({
        id: e.frontmatter.id,
        rule: b.rule ?? "",
        subject: b.subject ?? "",
        subjectType: b.subjectType ?? "",
        detail: b.detail ?? "",
      });
    } catch {
      // skip malformed (defensive)
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
