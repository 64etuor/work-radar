import { describe, it, expect } from "vitest";
import { serializeEvent, parseEvent, type GovEvent } from "../../src/event/event.js";

describe("orchestrator_suggestion_created event type", () => {
  it("round-trips serialize → parse", () => {
    const evt: GovEvent = {
      frontmatter: {
        id: "evt_20260603_140000_0001",
        type: "orchestrator_suggestion_created",
        source: "system",
        actor: "system",
        tags: ["orchestrator", "suggestion"],
        related_to: ["evt_task0"],
      },
      body: JSON.stringify({ rule: "task_needs_session", subject: "evt_task0", subjectType: "task", detail: "x" }),
    };
    const round = parseEvent(serializeEvent(evt));
    expect(round.frontmatter.type).toBe("orchestrator_suggestion_created");
    expect(JSON.parse(round.body).rule).toBe("task_needs_session");
  });
});
