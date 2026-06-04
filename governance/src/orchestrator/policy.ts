import type { SessionPhase } from "../session/session.ts";
import type { OrchestratorView } from "./view.ts";

export type RuleId =
  | "session_checkpoint"
  | "task_needs_session"
  | "session_stale"
  | "task_blocked_decision"
  | "orphan_session";

export interface SuggestionCandidate {
  ruleId: RuleId;
  subjectId: string;
  subjectType: "session" | "task";
  detail: string;
}

/** "active-like" = a live, observed session (mirror of session/observer.ts ALIVE_OBSERVED): every
 *  phase except the pre-birth births (planned/opening) and the terminal (closed). */
const ACTIVE_LIKE: ReadonlySet<SessionPhase> = new Set<SessionPhase>([
  "active",
  "waiting",
  "blocked",
  "context_pressure_high",
  "checkpoint_requested",
  "handoff_ready",
  "recovering",
]);

/** PURE: cross-fold view → advisory suggestion candidates (master §4.3 anemic auto). No I/O, no
 *  emit, no verdict. Output is deterministically sorted by (ruleId, subjectId). No rule suppression
 *  or priority in this slice — one subject may fire multiple distinct-key candidates. */
export function evaluateSuggestions(view: OrchestratorView): SuggestionCandidate[] {
  const out: SuggestionCandidate[] = [];
  const taskById = new Map(view.tasks.map((t) => [t.state.taskId, t]));
  const boundTaskIds = new Set(
    view.sessions
      .filter((s) => s.phase !== "closed" && s.taskId !== null)
      .map((s) => s.taskId as string),
  );

  for (const s of view.sessions) {
    const activeLike = ACTIVE_LIKE.has(s.phase);
    if (s.phase === "context_pressure_high") {
      out.push({ ruleId: "session_checkpoint", subjectId: s.sessionId, subjectType: "session", detail: "context pressure high — checkpoint recommended" });
    }
    if (activeLike && s.taskId !== null) {
      const t = taskById.get(s.taskId);
      if (t && (t.state.phase === "done" || t.state.phase === "cancelled")) {
        out.push({ ruleId: "session_stale", subjectId: s.sessionId, subjectType: "session", detail: `bound task ${s.taskId} is ${t.state.phase} — consider closing` });
      }
    }
    if (activeLike && s.taskId === null && s.ownership === "external_owned") {
      out.push({ ruleId: "orphan_session", subjectId: s.sessionId, subjectType: "session", detail: "orphan session with no bound task" });
    }
  }

  for (const t of view.tasks) {
    const terminal = t.state.phase === "done" || t.state.phase === "cancelled";
    if (t.state.phase === "active" && !boundTaskIds.has(t.state.taskId)) {
      out.push({ ruleId: "task_needs_session", subjectId: t.state.taskId, subjectType: "task", detail: "active task with no open session" });
    }
    if (!terminal && t.hasOpenBlock) {
      out.push({ ruleId: "task_blocked_decision", subjectId: t.state.taskId, subjectType: "task", detail: "unresolved decision_blocked in task chain — needs human" });
    }
  }

  return out.sort((a, b) =>
    a.ruleId === b.ruleId ? a.subjectId.localeCompare(b.subjectId) : a.ruleId.localeCompare(b.ruleId),
  );
}
