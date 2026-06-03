import type { GovEvent } from "../event/event.ts";
import { projectTasks } from "../task/project.ts";
import { projectPlans } from "../plan/project.ts";
import { projectSessions } from "../session/project.ts";
import { hasOpenBlock } from "../task/handlers.ts";
import type { TaskState } from "../task/task.ts";
import type { PlanState } from "../plan/plan.ts";
import type { SessionState } from "../session/session.ts";

export interface TaskView {
  state: TaskState;
  /** Reuses task/handlers.hasOpenBlock — the EXACT INVARIANT #1 coupling, not a duplicate fold. */
  hasOpenBlock: boolean;
}

export interface OrchestratorView {
  tasks: TaskView[];
  plans: PlanState[];
  sessions: SessionState[];
}

/** PURE: events → cross-fold read model. Reuses the existing per-axis folds (god-fold ban, master
 *  §8) and the reused hasOpenBlock coupling. No I/O, emits no events. The keystone invariant holds:
 *  this is a total function of the event log (renderOrchestrator persists it; rebuildable byte-for-byte). */
export function projectOrchestratorView(all: GovEvent[]): OrchestratorView {
  const tasks: TaskView[] = projectTasks(all).map((state) => ({
    state,
    hasOpenBlock: hasOpenBlock(all, state.taskId),
  }));
  return { tasks, plans: projectPlans(all), sessions: projectSessions(all) };
}
