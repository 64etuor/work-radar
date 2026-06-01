import { describe, it, expect } from "vitest";
import {
  dedupe,
  extractRefs,
  truncate,
  firstParagraph,
  adrTitle,
  toStringArray,
} from "../../src/index/text.js";

describe("dedupe", () => {
  it("removes duplicates preserving order", () => {
    expect(dedupe(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
});

describe("extractRefs", () => {
  it("finds ADR-NNNN tokens", () => {
    expect(extractRefs("see ADR-0003 and ADR-0006, also ADR-0003")).toEqual([
      "ADR-0003",
      "ADR-0006",
      "ADR-0003",
    ]);
  });
  it("returns [] when none", () => {
    expect(extractRefs("no refs here")).toEqual([]);
  });
});

describe("truncate", () => {
  it("leaves short strings, trims long ones with an ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdefghij", 5)).toBe("abcde…");
  });
});

describe("firstParagraph", () => {
  it("returns the first non-heading paragraph, joined and truncated", () => {
    const body = "# 0007. Title\n\n## Context\n\n**Scope**: the sidecar.\nMore detail.\n\nNext para.";
    expect(firstParagraph(body)).toBe("**Scope**: the sidecar. More detail.");
  });
  it("returns empty string when there is no body text", () => {
    expect(firstParagraph("# Only\n## Headings")).toBe("");
  });
});

describe("adrTitle", () => {
  it("takes the first H1 and strips a leading 'N. ' prefix", () => {
    expect(adrTitle("# 0007. Governance Surface\n\nbody")).toBe("Governance Surface");
  });
  it("returns null when there is no H1", () => {
    expect(adrTitle("## only h2")).toBeNull();
  });
});

describe("toStringArray", () => {
  it("normalizes arrays, scalars, and null/undefined", () => {
    expect(toStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(toStringArray("a")).toEqual(["a"]);
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
  });
});
