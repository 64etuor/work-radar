import { describe, it, expect } from "vitest";
import { deriveDecisionState } from "../../src/decision/decision.js";
import type { GovEvent } from "../../src/event/event.js";

function ev(id: string, type: GovEvent["frontmatter"]["type"], related: string[], tags: string[] = []): GovEvent {
  return { frontmatter: { id, type, source: "hermes", actor: "user", tags, related_to: related }, body: id };
}

describe("deriveDecisionState — Type 0 chosen", () => {
  const proposal: GovEvent = {
    frontmatter: { id: "evt_d", type: "decision_proposed", source: "hermes", actor: "user", tags: ["decision", "type0"] },
    body: "DB: sqlite or postgres?",
  };

  it("a Type 0 with no resolution is phase=proposed (pending)", () => {
    const s = deriveDecisionState(proposal, [ev("evt_b", "decision_blocked", ["evt_d"])]);
    expect(s.phase).toBe("proposed");
    expect(s.verdict).toBeNull();
  });

  it("a decision_chosen resolves it to terminal chosen + surfaces the option", () => {
    const s = deriveDecisionState(proposal, [
      ev("evt_b", "decision_blocked", ["evt_d"]),
      ev("evt_c", "decision_chosen", ["evt_d", "evt_b"], ["decision", "option:opt1"]),
    ]);
    expect(s.phase).toBe("chosen");
    expect(s.verdict).toBe("chosen");
    expect(s.chosenOption).toBe("opt1");
  });

  it("rejected/approved still take precedence over chosen", () => {
    const s = deriveDecisionState(proposal, [
      ev("evt_c", "decision_chosen", ["evt_d"], ["option:opt0"]),
      ev("evt_r", "decision_rejected", ["evt_d"]),
    ]);
    expect(s.verdict).toBe("rejected");
  });
});
