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

  it("captures every top-level decision-log bullet from both logs (no silent drop)", async () => {
    const index = await buildIndex(REPO_ROOT, nodeIndexFs);
    const rootMd = await readFile(resolve(REPO_ROOT, "docs", "decisions.md"), "utf8");
    // Governance log is optional/fail-soft — treat absence as empty.
    const govMd = await readFile(
      resolve(REPO_ROOT, "governance", "docs", "decisions.md"),
      "utf8",
    ).catch(() => "");
    const rootBullets = (rootMd.match(/^- \*\*/gm) ?? []).length;
    const govBullets = (govMd.match(/^- \*\*/gm) ?? []).length;
    const dlRoot = index.decisions.filter(
      (d) => d.kind === "decision-log" && d.sourcePath === "docs/decisions.md",
    );
    const dlGov = index.decisions.filter(
      (d) => d.kind === "decision-log" && d.sourcePath === "governance/docs/decisions.md",
    );
    expect(rootBullets).toBeGreaterThan(100); // sanity: the real root log is large
    expect(dlRoot.length).toBe(rootBullets); // capture all root bullets, not a subset
    expect(dlGov.length).toBe(govBullets); // capture all governance bullets too
  });
});
