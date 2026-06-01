import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildIndex, nodeIndexFs } from "../../src/index/build.js";
import { formatDecisions, formatPrinciples } from "../../src/index/format.js";

// governance/test/index → governance/test → governance → <repo root>
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

describe("buildIndex against the real repo L3/L4 corpus", () => {
  it("ingests the real ADRs and INVARIANTs", async () => {
    const index = await buildIndex(REPO_ROOT, nodeIndexFs);
    const ids = index.listDecisions().map((d) => d.id);
    expect(ids).toContain("ADR-0001");
    expect(ids).toContain("ADR-0007");
    expect(index.listPrinciples().some((p) => p.id === "INVARIANT-1")).toBe(true);
    expect(index.getDecision("ADR-9999")).toBeNull();
    // formatters produce non-empty text over the real corpus
    expect(formatDecisions(index)).toContain("ADR-0001");
    expect(formatPrinciples(index)).toContain("INVARIANT-1");
  });
});
