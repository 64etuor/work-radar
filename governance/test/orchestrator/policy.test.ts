import { describe, it, expect } from "vitest";
import { evaluateSuggestions } from "../../src/orchestrator/policy.js";
import type { OrchestratorView } from "../../src/orchestrator/view.js";
import type { SessionState } from "../../src/session/session.js";
import type { TaskState } from "../../src/task/task.js";

function task(taskId: string, phase: TaskState["phase"], hasOpenBlock = false) {
  const verdict = phase === "done" ? "done" : phase === "cancelled" ? "cancelled" : null;
  return { state: { taskId, title: taskId, phase, verdict } as TaskState, hasOpenBlock };
}
function sess(sessionId: string, phase: SessionState["phase"], taskId: string | null, ownership: SessionState["ownership"] = "orchestrator_owned"): SessionState {
  return { sessionId, surface: "1", ownership, taskId, phase, verdict: phase === "closed" ? "closed" : null };
}
const view = (over: Partial<OrchestratorView>): OrchestratorView => ({ tasks: [], plans: [], sessions: [], ...over });

describe("evaluateSuggestions — the 5 rules", () => {
  it("rule 1 session_checkpoint: context_pressure_high session", () => {
    const out = evaluateSuggestions(view({ sessions: [sess("evt_s1", "context_pressure_high", "evt_t1")] }));
    expect(out.map((c) => c.ruleId)).toContain("session_checkpoint");
  });

  it("rule 2 task_needs_session: active task with no bound non-closed session", () => {
    const out = evaluateSuggestions(view({ tasks: [task("evt_t1", "active")] }));
    expect(out.find((c) => c.ruleId === "task_needs_session")?.subjectId).toBe("evt_t1");
  });

  it("rule 2 no-fire: active task that already has an open bound session", () => {
    const out = evaluateSuggestions(view({
      tasks: [task("evt_t1", "active")],
      sessions: [sess("evt_s1", "active", "evt_t1")],
    }));
    expect(out.some((c) => c.ruleId === "task_needs_session")).toBe(false);
  });

  it("rule 3 session_stale: active session whose bound task is done", () => {
    const out = evaluateSuggestions(view({
      tasks: [task("evt_t1", "done")],
      sessions: [sess("evt_s1", "active", "evt_t1")],
    }));
    expect(out.find((c) => c.ruleId === "session_stale")?.subjectId).toBe("evt_s1");
  });

  it("rule 4 task_blocked_decision: non-terminal task with open block", () => {
    const out = evaluateSuggestions(view({ tasks: [task("evt_t1", "blocked", true)] }));
    expect(out.find((c) => c.ruleId === "task_blocked_decision")?.subjectId).toBe("evt_t1");
  });

  it("rule 4 no-fire: terminal task is not flagged even with hasOpenBlock", () => {
    const out = evaluateSuggestions(view({ tasks: [task("evt_t1", "done", true)] }));
    expect(out.some((c) => c.ruleId === "task_blocked_decision")).toBe(false);
  });

  it("rule 5 orphan_session: active external_owned session with null task", () => {
    const out = evaluateSuggestions(view({ sessions: [sess("evt_s1", "active", null, "external_owned")] }));
    expect(out.find((c) => c.ruleId === "orphan_session")?.subjectId).toBe("evt_s1");
  });

  it("emits nothing for an empty view; output is deterministically sorted", () => {
    expect(evaluateSuggestions(view({}))).toEqual([]);
    const out = evaluateSuggestions(view({
      tasks: [task("evt_t2", "active"), task("evt_t1", "active")],
    }));
    expect(out.map((c) => c.subjectId)).toEqual(["evt_t1", "evt_t2"]);
  });
});
