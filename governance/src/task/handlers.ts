import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveDecisionState } from "../decision/decision.ts";
import { deriveTaskState, tasksOf, type TaskState } from "./task.ts";
import { canStart, canBlock, canComplete, canCancel } from "./guards.ts";

export interface TaskGateResult { ok: boolean; reason: string; eventId?: string; }

async function loadTask(workspaceDir: string, taskId: string): Promise<{ state: TaskState; all: GovEvent[] }> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, taskId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "task_created")
    throw new Error(`unknown task: ${taskId}`);
  return { state: deriveTaskState(grp.proposal, grp.related), all };
}

async function writeLifecycle(
  workspaceDir: string, type: EventType, taskId: string, body: string, now: Date, rand: number,
): Promise<string> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type, source: "hermes", actor: "user",
      tags: ["task"], related_to: [taskId],
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return evt.frontmatter.id;
}

/** True if a decision_blocked related to this task escalates a decision with NO verdict yet.
 *  Conservative: a block whose decision proposal cannot be found counts as open.
 *  Exported so the v3 Conductor's halt projection REUSES this exact coupling (not a duplicate). */
export function hasOpenBlock(all: GovEvent[], taskId: string): boolean {
  const blocks = all.filter(
    (e) => e.frontmatter.type === "decision_blocked" && (e.frontmatter.related_to ?? []).includes(taskId),
  );
  for (const b of blocks) {
    const relatedIds = b.frontmatter.related_to ?? [];
    const decId = relatedIds.find((rid) => {
      const p = all.find((e) => e.frontmatter.id === rid);
      return p?.frontmatter.type === "decision_proposed";
    });
    if (!decId) return true; // cannot prove resolved → conservative
    const grp = eventsForDecision(all, decId);
    if (grp.proposal && !deriveDecisionState(grp.proposal, grp.related).verdict) return true;
  }
  return false;
}

/** start_task — ready/blocked → active. */
export async function startTask(workspaceDir: string, input: { taskId: string }, now: Date, rand: number): Promise<TaskGateResult> {
  const { state } = await loadTask(workspaceDir, input.taskId);
  const gate = canStart(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "task_started", input.taskId, `Started ${input.taskId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** block_task — active → blocked (records reason). */
export async function blockTask(workspaceDir: string, input: { taskId: string; reason: string }, now: Date, rand: number): Promise<TaskGateResult> {
  const { state } = await loadTask(workspaceDir, input.taskId);
  const gate = canBlock(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "task_blocked", input.taskId, `Blocked ${input.taskId}: ${input.reason}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** complete_task — active → done. Guarded by canComplete (incl. open-block coupling). */
export async function completeTask(workspaceDir: string, input: { taskId: string }, now: Date, rand: number): Promise<TaskGateResult> {
  const { state, all } = await loadTask(workspaceDir, input.taskId);
  const gate = canComplete(state, hasOpenBlock(all, input.taskId));
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "task_completed", input.taskId, `Completed ${input.taskId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** cancel_task — any non-terminal → cancelled. */
export async function cancelTask(workspaceDir: string, input: { taskId: string }, now: Date, rand: number): Promise<TaskGateResult> {
  const { state } = await loadTask(workspaceDir, input.taskId);
  const gate = canCancel(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "task_cancelled", input.taskId, `Cancelled ${input.taskId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

export interface TaskSummary { taskId: string; title: string; phase: TaskState["phase"]; }

/** tasks — non-terminal tasks. */
export async function listTasks(workspaceDir: string): Promise<TaskSummary[]> {
  const all = await readAllEvents(workspaceDir);
  const out: TaskSummary[] = [];
  for (const t of tasksOf(all)) {
    const grp = eventsForDecision(all, t.frontmatter.id);
    const s = deriveTaskState(grp.proposal!, grp.related);
    if (s.phase !== "done" && s.phase !== "cancelled") out.push({ taskId: s.taskId, title: s.title, phase: s.phase });
  }
  return out;
}

export interface TaskTrailEntry { id: string; type: GovEvent["frontmatter"]["type"]; actor: string; summary: string; }
export interface TaskTrail { taskId: string; title: string; phase: TaskState["phase"]; chain: TaskTrailEntry[]; }

/** task <id> — full chronological trail. */
export async function taskTrail(workspaceDir: string, input: { taskId: string }): Promise<TaskTrail> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, input.taskId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "task_created") throw new Error(`unknown task: ${input.taskId}`);
  const s = deriveTaskState(grp.proposal, grp.related);
  const chain: TaskTrailEntry[] = [grp.proposal, ...grp.related].map((e) => ({
    id: e.frontmatter.id, type: e.frontmatter.type, actor: e.frontmatter.actor,
    summary: e.body.split("\n", 1)[0] ?? "",
  }));
  return { taskId: s.taskId, title: s.title, phase: s.phase, chain };
}
