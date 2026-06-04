import { readAllEvents } from "../../decision/readEvents.ts";

export interface DispatchLogEntry {
  id: string;
  type: "instruction_planned" | "orchestrator_action_executed" | "orchestrator_action_failed" | "action_denied";
  planId: string;
  stepIndex: number | null;
  reason: string | null;
  taskId: string | null;
}

const DISPATCH_TYPES = new Set<DispatchLogEntry["type"]>([
  "instruction_planned",
  "orchestrator_action_executed",
  "orchestrator_action_failed",
  "action_denied",
]);

export async function listDispatchLog(workspaceDir: string): Promise<DispatchLogEntry[]> {
  const all = await readAllEvents(workspaceDir);
  const out: DispatchLogEntry[] = [];
  for (const e of all) {
    const type = e.frontmatter.type as DispatchLogEntry["type"];
    if (!DISPATCH_TYPES.has(type)) continue;
    let body: { planId?: string; stepIndex?: number; reason?: string; taskId?: string } = {};
    try {
      body = JSON.parse(e.body) as typeof body;
    } catch {
      // Dispatcher writes canonical JSON; malformed historical rows degrade to empty fields.
    }
    out.push({
      id: e.frontmatter.id,
      type,
      planId: body.planId ?? (e.frontmatter.related_to ?? [])[0] ?? "",
      stepIndex: typeof body.stepIndex === "number" ? body.stepIndex : null,
      reason: body.reason ?? null,
      taskId: body.taskId ?? null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
