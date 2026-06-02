import type { GovEvent } from "../event/event.ts";

export type TaskPhase = "ready" | "active" | "blocked" | "done" | "cancelled";

export interface TaskState {
  taskId: string;
  title: string;
  phase: TaskPhase;
  verdict: "done" | "cancelled" | null; // terminal marker (mirrors DecisionState.verdict)
}

/** Pure fold: a task_created event + its related lifecycle events → phase.
 *  `related` = events whose related_to includes the task id (any order).
 *  Precedence: cancelled > done; otherwise the LATEST started/blocked transition wins by the
 *  id tiebreak. ORDERING CONTRACT (Boule, docs/decisions.md): event ids
 *  (prefix_YYYYMMDD_HHMMSS_<4hex-random>) are display/tiebreak-only — the random suffix is NOT
 *  monotonic within a second, so causality is carried by explicit references, never id-order.
 *  Two same-second started/blocked transitions on one task stream do not occur in practice
 *  (human-paced), so this tiebreak is a benign display nicety, not load-bearing. */
export function deriveTaskState(created: GovEvent, related: GovEvent[]): TaskState {
  const taskId = created.frontmatter.id;
  const title = created.body.split("\n", 1)[0]?.trim() || taskId;
  const cancelled = related.some((e) => e.frontmatter.type === "task_cancelled");
  const done = related.some((e) => e.frontmatter.type === "task_completed");

  let phase: TaskPhase;
  let verdict: TaskState["verdict"];
  if (cancelled) {
    phase = "cancelled";
    verdict = "cancelled";
  } else if (done) {
    phase = "done";
    verdict = "done";
  } else {
    let latest: GovEvent | null = null;
    for (const e of related) {
      if (e.frontmatter.type !== "task_started" && e.frontmatter.type !== "task_blocked") continue;
      if (!latest || e.frontmatter.id.localeCompare(latest.frontmatter.id) > 0) latest = e;
    }
    phase = !latest ? "ready" : latest.frontmatter.type === "task_blocked" ? "blocked" : "active";
    verdict = null;
  }
  return { taskId, title, phase, verdict };
}

/** All task_created events (chronological by id). */
export function tasksOf(all: GovEvent[]): GovEvent[] {
  return all
    .filter((e) => e.frontmatter.type === "task_created")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}
