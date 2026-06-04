import { describe, expect, it } from "vitest";
import type { HypothesisRecord } from "../../src/hypotheses/types.ts";
import { assertSafeArchiveId, shouldArchiveHypothesis } from "../../src/archive/pruner.ts";

function record(overrides: Partial<HypothesisRecord>): HypothesisRecord {
  return {
    id: "hyp_safe",
    fromPattern: "pat_scope_a",
    kind: "commit_scope_hotspot_persists",
    scope: "governance",
    status: "testing",
    testMethod: "current_l0_scope_count",
    baseline: 5,
    threshold: 5,
    expires: "2026-06-04",
    body: "Hypothesis.\n",
    ...overrides,
  };
}

describe("shouldArchiveHypothesis", () => {
  it("archives terminal hypotheses", () => {
    expect(shouldArchiveHypothesis(record({ status: "verified" }), "2026-06-04")).toBe(true);
    expect(shouldArchiveHypothesis(record({ status: "refuted" }), "2026-06-04")).toBe(true);
    expect(shouldArchiveHypothesis(record({ status: "archived" }), "2026-06-04")).toBe(true);
  });

  it("archives only expired testing hypotheses", () => {
    expect(shouldArchiveHypothesis(record({ status: "testing", expires: "2026-06-03" }), "2026-06-04")).toBe(
      true,
    );
    expect(shouldArchiveHypothesis(record({ status: "testing", expires: "2026-06-04" }), "2026-06-04")).toBe(
      false,
    );
    expect(shouldArchiveHypothesis(record({ status: "testing", expires: "2026-06-05" }), "2026-06-04")).toBe(
      false,
    );
  });
});

describe("assertSafeArchiveId", () => {
  it("rejects ids that could escape the archive tree", () => {
    expect(() => assertSafeArchiveId("hyp_safe_123")).not.toThrow();
    expect(() => assertSafeArchiveId("../hyp_bad")).toThrow(/Unsafe hypothesis id/);
    expect(() => assertSafeArchiveId("hyp.bad")).toThrow(/Unsafe hypothesis id/);
  });
});
