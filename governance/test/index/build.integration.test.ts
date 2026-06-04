import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildIndex, nodeIndexFs } from "../../src/index/build.js";
import { formatDecisions, formatPrinciples } from "../../src/index/format.js";

// governance/test/index → governance/test → governance → <repo root>
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

describe("buildIndex against the real repo L3/L4 corpus", () => {
  it("ingests the real ADRs and INVARIANTs", async () => {
    const index = await buildIndex(REPO_ROOT, nodeIndexFs);
    const ids = index.decisions.map((d) => d.id);
    expect(ids).toContain("ADR-0001");
    expect(ids).toContain("ADR-0007");
    expect(index.principles.some((p) => p.id === "INVARIANT-1")).toBe(true);
    expect(index.getDecision("ADR-9999")).toBeNull();
    // formatters produce non-empty text over the real corpus
    expect(formatDecisions(index)).toContain("ADR-0001");
    expect(formatPrinciples(index)).toContain("INVARIANT-1");
  });

  it("captures every top-level decision-log bullet (no silent drop)", async () => {
    const index = await buildIndex(REPO_ROOT, nodeIndexFs);
    const decisionsMd = await readFile(resolve(REPO_ROOT, "docs", "decisions.md"), "utf8");
    // Every top-level `- **…` bullet is a decision-log entry; none may be dropped.
    const bulletCount = (decisionsMd.match(/^- \*\*/gm) ?? []).length;
    const dlRows = index.decisions.filter((d) => d.kind === "decision-log");
    expect(bulletCount).toBeGreaterThan(100); // sanity: the real log is large
    expect(dlRows.length).toBe(bulletCount); // capture all, not a 35% subset
  });
});
