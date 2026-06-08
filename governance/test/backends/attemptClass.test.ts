import { describe, it, expect } from "vitest";

import { classifyAttemptEvidence } from "../../src/backends/attemptClass.js";

describe("classifyAttemptEvidence", () => {
  it("maps nonzero quota/auth stderr signatures before useful work to token_exhausted", () => {
    expect(
      classifyAttemptEvidence({
        exitCode: 1,
        launched: false,
        stderrDigest: "Auth failed after usage limit reached",
      }),
    ).toBe("token_exhausted");
    expect(
      classifyAttemptEvidence({
        exitCode: 2,
        launched: true,
        stderrDigest: "insufficient_quota for project",
      }),
    ).toBe("token_exhausted");
  });

  it("maps clean exit to ok", () => {
    expect(classifyAttemptEvidence({ exitCode: 0, launched: true })).toBe("ok");
  });

  it("maps weak ambiguous nonzero exits conservatively and deterministically", () => {
    const input = { exitCode: 2, launched: true, stderrDigest: "model returned empty output" };
    expect(classifyAttemptEvidence(input)).toBe("fatal");
    expect(classifyAttemptEvidence(input)).toBe("fatal");
  });

  it("preserves transient signatures from the synchronous fallback classifier", () => {
    expect(
      classifyAttemptEvidence({
        exitCode: 1,
        launched: true,
        stderrDigest: "request timed out",
      }),
    ).toBe("transient");
  });
});
