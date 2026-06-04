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

  it("reviewed after a distinct-model review event, still no verdict", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] }),
    ]);
    expect(s.phase).toBe("reviewed");
    expect(s.reviewed).toBe(true);
    expect(s.reviewCount).toBe(1);
    expect(s.verdict).toBeNull();
  });

  it("does NOT count a forged same-model review (reviewer == author)", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "claude", tags: ["author_model:claude"] }),
    ]);
    expect(s.phase).toBe("proposed");
    expect(s.reviewed).toBe(false);
    expect(s.reviewCount).toBe(0);
  });

  it("does NOT count a review missing the author_model tag (fail-closed)", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: [] }),
    ]);
    expect(s.reviewed).toBe(false);
    expect(s.reviewCount).toBe(0);
  });

  it("normalizes models when comparing (Claude:latest == claude → not counted)", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "Claude:latest", tags: ["author_model:claude"] }),
    ]);
    expect(s.reviewCount).toBe(0); // raw compare would have counted; normalize catches the drift
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

  it("counts DISTINCT reviewer models, not events (two same-model reviews → 1)", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] }),
      evt("decision_review_recorded", { source: "reviewer", actor: "Codex:latest", tags: ["author_model:claude"] }),
    ]);
    expect(s.reviewCount).toBe(1); // codex == Codex:latest after normalize
  });

  it("counts two DISTINCT models as 2", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] }),
      evt("decision_review_recorded", { source: "reviewer", actor: "gemini", tags: ["author_model:claude"] }),
    ]);
    expect(s.reviewCount).toBe(2);
  });

  it("quorum 2: one distinct review stays 'proposed' (not reviewed)", () => {
    const s = deriveDecisionState(
      proposal,
      [evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] })],
      2,
    );
    expect(s.phase).toBe("proposed");
    expect(s.reviewed).toBe(false);
    expect(s.reviewCount).toBe(1);
  });

  it("quorum 2: two distinct reviews → 'reviewed'", () => {
    const s = deriveDecisionState(
      proposal,
      [
        evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] }),
        evt("decision_review_recorded", { source: "reviewer", actor: "gemini", tags: ["author_model:claude"] }),
      ],
      2,
    );
    expect(s.phase).toBe("reviewed");
    expect(s.reviewed).toBe(true);
    expect(s.reviewCount).toBe(2);
  });

  it("default quorum is 1 (omitted arg behaves as today)", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] }),
    ]);
    expect(s.reviewed).toBe(true);
  });

  it("fail-closed: a review event with non-array tags is not counted (no crash)", () => {
    const bad = evt("decision_review_recorded", { source: "reviewer", actor: "codex" });
    // simulate a corrupt/hand-edited event whose tags is not an array
    (bad.frontmatter as { tags: unknown }).tags = "author_model:claude";
    const s = deriveDecisionState(proposal, [bad]);
    expect(s.reviewCount).toBe(0);
    expect(s.reviewed).toBe(false);
  });
});
