import { describe, it, expect } from "vitest";
import { serializeEvent, parseEvent, type GovEvent } from "../../src/event/event.js";

describe("handoff event types", () => {
  it("round-trips a handoff_requested event", () => {
    const evt: GovEvent = {
      frontmatter: {
        id: "evt_20260603_130000_0001",
        type: "handoff_requested",
        source: "system",
        actor: "system",
        tags: ["handoff"],
        related_to: ["evt_session_001"],
      },
      body: "Handoff requested",
    };
    const round = parseEvent(serializeEvent(evt));
    expect(round.frontmatter.type).toBe("handoff_requested");
  });
});
