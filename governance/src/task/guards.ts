import type { TaskState } from "./task.ts";

export interface TaskGate { ok: boolean; reason: string; }

/** Start is allowed from ready or blocked (the latter = unblock). */
export function canStart(s: TaskState): TaskGate {
  if (s.verdict) return { ok: false, reason: `task already ${s.verdict}` };
  if (s.phase === "active") return { ok: false, reason: "task already active" };
  return { ok: true, reason: s.phase === "blocked" ? "unblocking" : "starting" };
}

/** A task may complete ONLY from active AND with no unresolved decision_blocked in its
 *  chain. The open-block clause is the structural INVARIANT #1 coupling: a task cannot be
 *  marked done while it sits on an unanswered Type-0 fork. `hasOpenBlock` is computed by the
 *  handler (I/O); this guard stays pure. */
export function canComplete(s: TaskState, hasOpenBlock: boolean): TaskGate {
  if (s.verdict) return { ok: false, reason: `task already ${s.verdict}` };
  if (s.phase !== "active") return { ok: false, reason: `task must be active to complete (is ${s.phase})` };
  if (hasOpenBlock) return { ok: false, reason: "task has an unresolved decision_blocked; resolve the escalation first" };
  return { ok: true, reason: "completing" };
}

/** Cancel is allowed at any non-terminal phase. */
export function canCancel(s: TaskState): TaskGate {
  if (s.verdict) return { ok: false, reason: `task already ${s.verdict}` };
  return { ok: true, reason: "cancelling" };
}
