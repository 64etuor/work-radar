import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveTaskState, tasksOf, type TaskState } from "./task.ts";

/** PURE: events → task states (sorted by task id via tasksOf). No I/O, emits no events. */
export function projectTasks(all: GovEvent[]): TaskState[] {
  return tasksOf(all).map((t) => {
    const grp = eventsForDecision(all, t.frontmatter.id);
    return deriveTaskState(grp.proposal!, grp.related);
  });
}

/** Render the derived projection to state/tasks.json. Overwrites; fully rebuildable from
 *  events. Deterministic field + element order → byte-stable output. This is the ONLY writer
 *  of task status; no command/agent/human edits status directly (HARNESS keystone invariant). */
export async function renderTasks(workspaceDir: string): Promise<string> {
  const states = projectTasks(await readAllEvents(workspaceDir));
  const stateDir = join(workspaceDir, "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "tasks.json");
  const rows = states.map((s) => ({ taskId: s.taskId, title: s.title, phase: s.phase }));
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
  return path;
}
