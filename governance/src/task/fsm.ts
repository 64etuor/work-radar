import type { TaskPhase } from "./task.ts";

// Explicit task lifecycle FSM (architecture review 2026-06-29: the transition rules were correct
// but implicit — scattered across the can* guards in guards.ts and the precedence fold in task.ts,
// with no single readable representation). This module is the SSOT for "which phase may follow
// which"; fsm.test.ts drift-locks it against the can* guards so neither can change alone.
//
// NOTE on a "stuck" phase: the architecture review floated adding a `stuck` TaskPhase. It is
// deliberately NOT added here — a stuck task is not a new lifecycle state the writer transitions
// INTO (there is no task_stuck event, and inventing one needs a writer + schema migration). The
// "nobody owns this state" case (a session that died with its task still active) is surfaced as a
// read-only StalledTask observation by deriveStalledTasks (orchestrator/stall.ts), which is the
// right layer: it derives stuck-ness from session liveness + a TTL, leaving the task phase honest.

/** Each phase → the phases it may legally transition to. Terminal phases (done/cancelled) have no
 *  outgoing edges. Mirrors the design state machine:
 *    ready ──start──▶ active ──block──▶ blocked ──start(unblock)──▶ active
 *    active ──complete──▶ done
 *    (ready|active|blocked) ──cancel──▶ cancelled */
export const TASK_TRANSITIONS: Record<TaskPhase, TaskPhase[]> = {
  ready: ["active", "cancelled"],
  active: ["blocked", "done", "cancelled"],
  blocked: ["active", "cancelled"],
  done: [],
  cancelled: [],
};

/** The lifecycle verb (and underlying event family) that produces each target phase. Used by the
 *  drift-lock test to pick the can* guard that owns a given edge; null when no transition targets
 *  that phase (nothing transitions back to `ready`). */
export type TaskTransition = "start" | "block" | "complete" | "cancel";

export function transitionFor(to: TaskPhase): TaskTransition | null {
  switch (to) {
    case "active":
      return "start"; // ready→active or blocked→active (unblock) both go through task_started
    case "blocked":
      return "block";
    case "done":
      return "complete";
    case "cancelled":
      return "cancel";
    case "ready":
      return null; // birth phase only — no transition leads back to it
  }
}

export function isValidTransition(from: TaskPhase, to: TaskPhase): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertValidTransition(from: TaskPhase, to: TaskPhase): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`illegal task transition: ${from} → ${to}`);
  }
}
