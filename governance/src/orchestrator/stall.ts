import type { GovEvent } from "../event/event.ts";
import { readAllEvents } from "../decision/readEvents.ts";
import { parseIdStampUtc } from "../event/id.ts";
import { projectTasks } from "../task/project.ts";
import { projectSessions } from "../session/project.ts";
import { DEFAULT_SESSION_TTL_MS } from "./constants.ts";

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
  reason:
    | "session_crashed"
    | "session_closed_no_attempt"
    | "transient_failure"
    | "session_timeout";
}

/** Non-terminal task phases that a crashed session leaves genuinely stuck (a ready task has no
 *  bound session yet; done/cancelled are terminal and need no attention). */
const IN_FLIGHT_TASK_PHASES = new Set(["active", "blocked"]);

/** Session phases the TTL fallback ages out: a session spawned but never marked active by the
 *  Observer ("opening"), or running with no terminal event ("active"). Deliberately NOT "blocked"
 *  / "waiting" — those reflect a deliberate pause (e.g. a human-pending escalation), not a silent
 *  hang, and the halt gate already surfaces them. */
const TTL_ELIGIBLE_SESSION_PHASES = new Set(["opening", "active"]);

/** Pure: tasks that are still in-flight but whose bound (Phase-C spawned) session is stuck.
 *  Deterministic order = session projection order.
 *
 *  When `now` is supplied, an Observer-independent TTL fallback also fires: an `active` session
 *  (never closed, never crashed) whose spawn-event id is older than `ttlMs` is surfaced as
 *  `session_timeout`. Omitting `now` keeps the legacy crash/closed-only behavior byte-identical —
 *  every existing call site is unaffected. */
export function deriveStalledTasks(
  all: GovEvent[],
  now?: Date,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): StalledTask[] {
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
      continue;
    }

    // TTL fallback (graceful degradation when the Observer is not running): an active session that
    // never terminated within ttlMs is treated as stalled. The spawn instant is read from the
    // session-spawn event id (no separate clock field). Only runs when a clock is supplied.
    if (now && TTL_ELIGIBLE_SESSION_PHASES.has(s.phase)) {
      const spawnedAt = parseIdStampUtc(s.sessionId);
      if (spawnedAt && now.getTime() - spawnedAt.getTime() >= ttlMs) {
        out.push({
          taskId: s.taskId,
          sessionId: s.sessionId,
          surface: s.surface,
          taskPhase: tp,
          reason: "session_timeout",
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

/** Read-only IO wrapper: read events and derive. Writes nothing. Pass `now` to enable the
 *  Observer-independent TTL fallback (the live tick/readiness paths do; pure tests may omit it). */
export async function listStalledTasks(
  workspaceDir: string,
  now?: Date,
): Promise<StalledTask[]> {
  return deriveStalledTasks(await readAllEvents(workspaceDir), now);
}
