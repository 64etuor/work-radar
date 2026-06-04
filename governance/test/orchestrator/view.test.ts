import { describe, it, expect } from "vitest";
import { projectOrchestratorView } from "../../src/orchestrator/view.js";
import type { GovEvent } from "../../src/event/event.js";

function ev(id: string, type: GovEvent["frontmatter"]["type"], body = "", related?: string[]): GovEvent {
  return {
    frontmatter: { id, type, source: "system", actor: "user", tags: [], ...(related ? { related_to: related } : {}) },
    body,
  };
}

describe("projectOrchestratorView", () => {
  it("joins task/plan/session folds and computes per-task hasOpenBlock", () => {
    const all: GovEvent[] = [
      ev("evt_t1", "task_created", "Build X"),
      ev("evt_t1s", "task_started", "Started", ["evt_t1"]),
      ev("evt_p1", "plan_proposed", "Plan A"),
      ev("evt_s1", "session_opened", JSON.stringify({ surface: "3", ownership: "external_owned" })),
      ev("evt_b1", "decision_blocked", JSON.stringify({ question: "?" }), ["evt_dec1", "evt_t1"]),
    ];
    const view = projectOrchestratorView(all);
    expect(view.tasks.find((t) => t.state.taskId === "evt_t1")?.state.phase).toBe("active");
    expect(view.tasks.find((t) => t.state.taskId === "evt_t1")?.hasOpenBlock).toBe(true);
    expect(view.plans.map((p) => p.planId)).toContain("evt_p1");
    expect(view.sessions.find((s) => s.sessionId === "evt_s1")?.ownership).toBe("external_owned");
  });

  it("is pure — same input twice yields deep-equal output", () => {
    const all: GovEvent[] = [ev("evt_t1", "task_created", "X")];
    expect(projectOrchestratorView(all)).toEqual(projectOrchestratorView(all));
  });
});
