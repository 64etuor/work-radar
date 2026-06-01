import { describe, it, expect } from "vitest";
import { formatDecision, formatDecisions, formatPrinciples } from "../../src/index/format.js";
import type { DecisionEntry, GovernanceIndex } from "../../src/index/types.js";

function fakeIndex(over: Partial<GovernanceIndex>): GovernanceIndex {
  return {
    decisions: [],
    principles: [],
    listDecisions: () => over.decisions ?? [],
    listPrinciples: () => over.principles ?? [],
    getDecision: () => null,
    ...over,
  };
}

describe("formatPrinciples", () => {
  it("lists 'id — title' per line", () => {
    const idx = fakeIndex({
      principles: [
        { id: "INVARIANT-1", number: 1, title: "people only", body: "", sourcePath: "r.md" },
      ],
    });
    expect(formatPrinciples(idx)).toBe("INVARIANT-1 — people only");
  });
  it("handles empty", () => {
    expect(formatPrinciples(fakeIndex({}))).toBe("no principles found");
  });
});

describe("formatDecisions", () => {
  it("lists 'id [status] — title', omitting status when absent", () => {
    const idx = fakeIndex({
      decisions: [
        { id: "ADR-0007", kind: "adr", title: "Surface", status: "accepted", tags: [], supersedes: [], refs: [], excerpt: "", sourcePath: "a.md" },
        { id: "DL-001", kind: "decision-log", title: "A thing", tags: [], supersedes: [], refs: [], excerpt: "", sourcePath: "d.md" },
      ],
    });
    expect(formatDecisions(idx)).toBe("ADR-0007 [accepted] — Surface\nDL-001 — A thing");
  });
});

describe("formatDecision", () => {
  it("renders detail + reference graph", () => {
    const entry: DecisionEntry = {
      row: { id: "ADR-0002", kind: "adr", title: "B", status: "accepted", date: "2026-01-01", tags: [], supersedes: ["ADR-0001"], refs: ["ADR-0003"], excerpt: "why B", sourcePath: "b.md" },
      supersededBy: ["ADR-0005"],
      referencedBy: ["ADR-0004"],
    };
    const text = formatDecision(entry, "ADR-0002");
    expect(text).toContain("ADR-0002 [accepted] — B");
    expect(text).toContain("date: 2026-01-01");
    expect(text).toContain("why B");
    expect(text).toContain("supersedes: ADR-0001");
    expect(text).toContain("superseded-by: ADR-0005");
    expect(text).toContain("refs: ADR-0003");
    expect(text).toContain("referenced-by: ADR-0004");
  });
  it("returns a friendly not-found for a null entry", () => {
    expect(formatDecision(null, "ADR-9999")).toBe("not found: ADR-9999");
  });
});
