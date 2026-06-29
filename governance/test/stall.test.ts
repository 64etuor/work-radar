import { describe, expect, it } from "vitest";
import { deriveStalledTasks } from "../src/orchestrator/stall.js";
import type { GovEvent } from "../src/event/event.js";

function ev(
  id: string,
  type: GovEvent["frontmatter"]["type"],
  related_to: string[],
  body = "",
): GovEvent {
  return {
    frontmatter: {
      id,
      type,
      source: "system",
      actor: "system",
      tags: [],
      related_to,
    },
    body,
  };
}

function attemptFinished(
  taskId: string,
  attemptIndex: number,
  outcomeClass: "ok" | "token_exhausted" | "transient" | "fatal",
): GovEvent {
  return ev(
    `evt_attempt_finished_${attemptIndex}_${outcomeClass}`,
    "executor_attempt_finished",
    [taskId],
    JSON.stringify({
      attemptIndex,
      exitCode: outcomeClass === "ok" ? 0 : 1,
      launched: true,
      worktreeDirty: false,
      outcomeClass,
      usage: "unknown",
    }),
  );
}

function activeTaskWithClosedSession(extra: GovEvent[] = []): GovEvent[] {
  return [
    ev("evt_task", "task_created", [], "step a"),
    ev("evt_task_started", "task_started", ["evt_task"]),
    ev("evt_session", "session_spawned", ["evt_task"], JSON.stringify({ surface: "stub-0" })),
    ...extra,
    ev("evt_session_closed", "session_closed", ["evt_session"]),
  ];
}

describe("deriveStalledTasks — closed sessions", () => {
  it("closed session with active task and no attempt_finished is stalled", () => {
    const stalled = deriveStalledTasks(activeTaskWithClosedSession());

    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({
      taskId: "evt_task",
      sessionId: "evt_session",
      taskPhase: "active",
      reason: "session_closed_no_attempt",
    });
  });

  it("closed session with transient failure is stalled", () => {
    const stalled = deriveStalledTasks(
      activeTaskWithClosedSession([attemptFinished("evt_task", 0, "transient")]),
    );

    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.reason).toBe("transient_failure");
  });

  it("token_exhausted with available retry chain is not stalled", () => {
    const stalled = deriveStalledTasks(
      activeTaskWithClosedSession([
        ev(
          "evt_attempt_started",
          "executor_attempt_started",
          ["evt_task"],
          JSON.stringify({ attemptIndex: 0, backend: { provider: "claude" } }),
        ),
        attemptFinished("evt_task", 0, "token_exhausted"),
      ]),
    );

    expect(stalled).toHaveLength(0);
  });
});
