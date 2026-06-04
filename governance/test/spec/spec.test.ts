import { describe, it, expect } from "vitest";
import { deriveSpecState, specsOf } from "../../src/spec/spec.js";
import type { GovEvent, EventType } from "../../src/event/event.js";

function evt(type: EventType, id: string, relatedTo?: string[], actor = "user", body = "Title line\n\nrest"): GovEvent {
  return { frontmatter: { id, type, source: "hermes", actor, tags: ["spec"], related_to: relatedTo }, body };
}
const proposed = evt("spec_proposed", "evt_s1", undefined, "author", "Governance MCP spec\n\nsummary");

describe("deriveSpecState", () => {
  it("a bare spec_proposed is draft", () => {
    expect(deriveSpecState(proposed, []).phase).toBe("draft");
  });
  it("title is the first body line", () => {
    expect(deriveSpecState(proposed, []).title).toBe("Governance MCP spec");
  });
  it("spec_accepted → accepted (non-terminal, verdict null)", () => {
    const s = deriveSpecState(proposed, [evt("spec_accepted", "evt_a2", ["evt_s1"])]);
    expect(s.phase).toBe("accepted"); expect(s.verdict).toBeNull();
  });
  it("spec_archived → archived (terminal, verdict set)", () => {
    const s = deriveSpecState(proposed, [evt("spec_archived", "evt_a3", ["evt_s1"])]);
    expect(s.phase).toBe("archived"); expect(s.verdict).toBe("archived");
  });
  it("archived wins over accepted (archive precedence)", () => {
    const s = deriveSpecState(proposed, [evt("spec_accepted", "evt_a2", ["evt_s1"]), evt("spec_archived", "evt_a3", ["evt_s1"])]);
    expect(s.phase).toBe("archived");
  });
  it("ignores unrelated event types (god-fold ban)", () => {
    const s = deriveSpecState(proposed, [evt("plan_accepted", "evt_x", ["evt_s1"]), evt("task_started", "evt_y", ["evt_s1"])]);
    expect(s.phase).toBe("draft");
  });
  it("specsOf filters spec_proposed only, chronological", () => {
    const all = [evt("spec_proposed", "evt_s2"), proposed, evt("spec_accepted", "evt_a2", ["evt_s1"])];
    expect(specsOf(all).map((e) => e.frontmatter.id)).toEqual(["evt_s1", "evt_s2"]);
  });
});
