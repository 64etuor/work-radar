import { describe, expect, it } from "vitest";
import { isTerminalHypothesisStatus, parseHypothesisMarkdown } from "../../src/hypotheses/hypothesis.ts";

describe("hypothesis markdown", () => {
  it("parses required frontmatter into a hypothesis record", () => {
    const record = parseHypothesisMarkdown(`---
id: hyp_12345678
from_pattern: pat_scope_abcdef12
kind: commit_scope_hotspot_persists
scope: governance
status: testing
test_method: current_l0_scope_count
baseline: 5
threshold: 5
expires: 2026-07-04
---
Commit scope hotspot should persist.
`);

    expect(record).toEqual({
      id: "hyp_12345678",
      fromPattern: "pat_scope_abcdef12",
      kind: "commit_scope_hotspot_persists",
      scope: "governance",
      status: "testing",
      testMethod: "current_l0_scope_count",
      baseline: 5,
      threshold: 5,
      expires: "2026-07-04",
      body: "Commit scope hotspot should persist.\n",
    });
  });

  it("classifies terminal statuses", () => {
    expect(isTerminalHypothesisStatus("verified")).toBe(true);
    expect(isTerminalHypothesisStatus("refuted")).toBe(true);
    expect(isTerminalHypothesisStatus("archived")).toBe(true);
    expect(isTerminalHypothesisStatus("testing")).toBe(false);
  });
});
