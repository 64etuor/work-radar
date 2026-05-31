import { describe, it, expect } from "vitest";
import { deriveDecisionState } from "../../src/decision/decision.js";
import type { GovEvent } from "../../src/event/event.js";

const ID = "evt_20260531_120000_aaaa";

function evt(type: GovEvent["frontmatter"]["type"], over: Partial<GovEvent["frontmatter"]> = {}, body = ""): GovEvent {
  return {
    frontmatter: { id: "evt_x", type, source: "hermes", actor: "user", tags: [], related_to: [ID], ...over },
    body,
  };
}
const proposal: GovEvent = {
  frontmatter: { id: ID, type: "decision_proposed", source: "hermes", actor: "user", tags: ["decision", "type1"] },
  body: "Adopt X\n\nrationale body",
};

describe("deriveDecisionState", () => {
  it("proposed when no review and no verdict", () => {
    const s = deriveDecisionState(proposal, []);
    expect(s.phase).toBe("proposed");
    expect(s.reviewed).toBe(false);
    expect(s.reviewCount).toBe(0);
    expect(s.verdict).toBeNull();
    expect(s.title).toBe("Adopt X");
  });

  it("reviewed after a review event, still no verdict", () => {
    const s = deriveDecisionState(proposal, [evt("decision_review_recorded", { source: "reviewer", actor: "external-reviewer" })]);
    expect(s.phase).toBe("reviewed");
    expect(s.reviewed).toBe(true);
    expect(s.reviewCount).toBe(1);
    expect(s.verdict).toBeNull();
  });

  it("approved when an approval event exists", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer" }),
      evt("decision_approved"),
    ]);
    expect(s.phase).toBe("approved");
    expect(s.verdict).toBe("approved");
  });

  it("rejected takes precedence as a terminal verdict", () => {
    const s = deriveDecisionState(proposal, [evt("decision_rejected")]);
    expect(s.phase).toBe("rejected");
    expect(s.verdict).toBe("rejected");
  });
});
