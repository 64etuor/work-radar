import { describe, it, expect } from "vitest";
import { buildReviewerEntries } from "../../src/mcp/reviewers.js";
import type { ReviewRequest } from "../../src/decision/reviewer.js";

const REQ: ReviewRequest = {
  decisionId: "evt_20260608_120000_aaaa",
  title: "Adopt X",
  proposalBody: "because reasons",
  authorModel: "claude",
};

describe("buildReviewerEntries", () => {
  it("reviewers omitted uses the env-models path exactly as before", async () => {
    const reviewers = buildReviewerEntries({
      env: { BOULE_REVIEWER_MODELS: "codex, gemini, Codex:latest" },
      fallbackReviewerModel: "external-stub",
      live: false,
      reviewerChains: undefined,
    });

    expect(reviewers.map((r) => r.model)).toEqual(["codex", "gemini"]);
    await expect(reviewers[0].fn(REQ)).resolves.toMatchObject({
      verdict: "concerns",
      reviewerModel: "codex",
    });
  });
});
