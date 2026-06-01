import { describe, it, expect } from "vitest";
import { parseQuorum, parseReviewerModels } from "../../src/mcp/config.js";

describe("parseQuorum", () => {
  it("parses a positive integer", () => {
    expect(parseQuorum("2")).toBe(2);
    expect(parseQuorum("3")).toBe(3);
  });
  it("clamps junk / <1 / undefined to the safe default 1 (never weakens the gate)", () => {
    for (const v of [undefined, "", "abc", "0", "-1", "1.9"]) {
      expect(parseQuorum(v)).toBe(1);
    }
  });
});

describe("parseReviewerModels", () => {
  it("splits, trims, drops empties, dedupes by normalized id", () => {
    expect(parseReviewerModels("codex, gemini ,Codex:latest", "fallback")).toEqual(["codex", "gemini"]);
  });
  it("falls back to the singular model when the list is unset/empty", () => {
    expect(parseReviewerModels(undefined, "external-stub")).toEqual(["external-stub"]);
    expect(parseReviewerModels("  ,  ", "external-stub")).toEqual(["external-stub"]);
  });
});
