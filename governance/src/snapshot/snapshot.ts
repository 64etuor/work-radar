import type { GovEvent } from "../event/event.ts";
import { projectHandoffs } from "../handoff/project.ts";
import { projectOrchestratorView } from "../orchestrator/view.ts";
import { projectPlans } from "../plan/project.ts";
import { projectSessions } from "../session/project.ts";
import { projectSpecs } from "../spec/project.ts";
import { projectTasks } from "../task/project.ts";
import type { HandoffPhase } from "../handoff/handoff.ts";
import type { PlanPhase } from "../plan/plan.ts";
import type { SessionPhase, Ownership } from "../session/session.ts";
import type { SpecPhase } from "../spec/spec.ts";
import type { TaskPhase } from "../task/task.ts";

export interface TaskRow {
  taskId: string;
  title: string;
  phase: TaskPhase;
}

export interface PlanRow {
  planId: string;
  title: string;
  phase: PlanPhase;
}

export interface SpecRow {
  specId: string;
  title: string;
  phase: SpecPhase;
}

export interface SessionRow {
  sessionId: string;
  surface: string | null;
  ownership: Ownership;
  taskId: string | null;
  phase: SessionPhase;
}

export interface HandoffRow {
  handoffId: string;
  sessionId: string;
  phase: HandoffPhase;
}

export interface OrchestratorTaskRow {
  taskId: string;
  phase: TaskPhase;
  hasOpenBlock: boolean;
}

export interface OrchestratorPlanRow {
  planId: string;
  phase: PlanPhase;
}

export interface OrchestratorSessionRow {
  sessionId: string;
  phase: SessionPhase;
  ownership: Ownership;
  taskId: string | null;
}

export interface OrchestratorRows {
  tasks: OrchestratorTaskRow[];
  plans: OrchestratorPlanRow[];
  sessions: OrchestratorSessionRow[];
}

export interface ControlRoomSnapshot {
  generatedAt: string | null;
  tasks: TaskRow[];
  plans: PlanRow[];
  specs: SpecRow[];
  sessions: SessionRow[];
  handoffs: HandoffRow[];
  orchestrator: OrchestratorRows;
}

function eventTimestamp(id: string): string | null {
  const match = id.match(/(\d{8})_(\d{6})/);
  if (!match) return null;
  const date = match[1];
  const time = match[2];
  if (!date || !time) return null;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
}

function newestEventTimestamp(events: GovEvent[]): string | null {
  let newest: string | null = null;
  for (const event of events) {
    const timestamp = eventTimestamp(event.frontmatter.id);
    if (timestamp && (!newest || timestamp > newest)) newest = timestamp;
  }
  return newest;
}

export function buildControlRoomSnapshot(events: GovEvent[]): ControlRoomSnapshot {
  const orchestrator = projectOrchestratorView(events);
  return {
    generatedAt: newestEventTimestamp(events),
    tasks: projectTasks(events).map((task) => ({
      taskId: task.taskId,
      title: task.title,
      phase: task.phase,
    })),
    plans: projectPlans(events).map((plan) => ({
      planId: plan.planId,
      title: plan.title,
      phase: plan.phase,
    })),
    specs: projectSpecs(events).map((spec) => ({
      specId: spec.specId,
      title: spec.title,
      phase: spec.phase,
    })),
    sessions: projectSessions(events).map((session) => ({
      sessionId: session.sessionId,
      surface: session.surface,
      ownership: session.ownership,
      taskId: session.taskId,
      phase: session.phase,
    })),
    handoffs: projectHandoffs(events).map((handoff) => ({
      handoffId: handoff.handoffId,
      sessionId: handoff.sessionId ?? "",
      phase: handoff.phase,
    })),
    orchestrator: {
      tasks: orchestrator.tasks.map((task) => ({
        taskId: task.state.taskId,
        phase: task.state.phase,
        hasOpenBlock: task.hasOpenBlock,
      })),
      plans: orchestrator.plans.map((plan) => ({
        planId: plan.planId,
        phase: plan.phase,
      })),
      sessions: orchestrator.sessions.map((session) => ({
        sessionId: session.sessionId,
        phase: session.phase,
        ownership: session.ownership,
        taskId: session.taskId,
      })),
    },
  };
}
