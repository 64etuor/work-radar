import type { GovEvent } from "../event/event.ts";
import { readAllEvents } from "../decision/readEvents.ts";
import { projectTasks } from "../task/project.ts";
import { projectSessions } from "../session/project.ts";

// L2 — Stall surfacing (master plan 2026-06-07, Phase L2).
//
// The Observer (session/observer.ts) already emits session_crashed when a spawned surface
// vanishes. But a crashed session whose TASK is still in-flight silently stalls the plan: the
// conductor waits forever for a task_completed that will never come (no timeout — by design).
// deriveStalledTasks joins the two derived projections to surface exactly that case so a human
// (or the Control Room) sees it instead of a silent halt.
//
// PURE + READ-ONLY: derives from events, writes nothing, mints no verdict. This is observability,
// not a decision — resolution stays human (cancel/re-dispatch the task, or recover the session).

export interface StalledTask {
  taskId: string;
  sessionId: string;
  surface: string | null;
  taskPhase: string; // the still-in-flight task phase (active|blocked)
  reason: "session_crashed" | "session_closed_no_attempt" | "transient_failure";
}

/** Non-terminal task phases that a crashed session leaves genuinely stuck (a ready task has no
 *  bound session yet; done/cancelled are terminal and need no attention). */
const IN_FLIGHT_TASK_PHASES = new Set(["active", "blocked"]);

/** Pure: tasks that are still in-flight but whose bound (Phase-C spawned) session has crashed.
 *  Deterministic order = session projection order. */
export function deriveStalledTasks(all: GovEvent[]): StalledTask[] {
  const taskPhase = new Map(projectTasks(all).map((t) => [t.taskId, t.phase]));
  const latestAttemptClass = new Map<string, string>();
  for (const e of all) {
    if (e.frontmatter.type !== "executor_attempt_finished") continue;
    const taskId = (e.frontmatter.related_to ?? [])[0];
    if (!taskId) continue;
    const body = safeAttemptBody(e.body);
    if (typeof body.outcomeClass === "string") latestAttemptClass.set(taskId, body.outcomeClass);
  }

  const out: StalledTask[] = [];
  for (const s of projectSessions(all)) {
    if (s.taskId === null) continue;
    const tp = taskPhase.get(s.taskId);
    if (!tp || !IN_FLIGHT_TASK_PHASES.has(tp)) continue;

    if (s.phase === "crashed") {
      out.push({
        taskId: s.taskId,
        sessionId: s.sessionId,
        surface: s.surface,
        taskPhase: tp,
        reason: "session_crashed",
      });
      continue;
    }

    if (s.phase === "closed") {
      const outcomeClass = latestAttemptClass.get(s.taskId);
      if (outcomeClass === "transient" || outcomeClass === "fatal") {
        out.push({
          taskId: s.taskId,
          sessionId: s.sessionId,
          surface: s.surface,
          taskPhase: tp,
          reason: "transient_failure",
        });
      } else if (!outcomeClass) {
        out.push({
          taskId: s.taskId,
          sessionId: s.sessionId,
          surface: s.surface,
          taskPhase: tp,
          reason: "session_closed_no_attempt",
        });
      }
    }
  }
  return out;
}

function safeAttemptBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Read-only IO wrapper: read events and derive. Writes nothing. */
export async function listStalledTasks(workspaceDir: string): Promise<StalledTask[]> {
  return deriveStalledTasks(await readAllEvents(workspaceDir));
}
