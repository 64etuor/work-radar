import { describe, it, expect } from "vitest";
import { validateHandoff, REQUIRED_SECTIONS } from "../../src/handoff/validate.js";

const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\nsome content for ${h}.`).join("\n\n");

describe("validateHandoff", () => {
  it("accepts a body with all 7 non-empty sections", () => {
    expect(validateHandoff(complete)).toEqual({ ok: true, missing: [] });
  });
  it("reports a missing section", () => {
    const body = REQUIRED_SECTIONS.slice(0, 6).map((h) => `## ${h}\nx`).join("\n\n");
    const r = validateHandoff(body);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("Open questions");
  });
  it("treats a present-but-empty section as missing", () => {
    const body = REQUIRED_SECTIONS.map((h, i) => `## ${h}\n${i === 0 ? "" : "x"}`).join("\n\n");
    const r = validateHandoff(body);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("Mission");
  });
});
