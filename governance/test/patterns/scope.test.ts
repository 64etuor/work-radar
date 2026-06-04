import { describe, it, expect } from "vitest";
import { parseScope } from "../../src/patterns/scope.js";

describe("parseScope", () => {
  it("extracts the scope from a conventional-commit subject", () => {
    expect(parseScope("feat(governance): add detector")).toBe("governance");
    expect(parseScope("docs(plan): cmd-knob 설계")).toBe("plan");
  });

  it("handles a breaking-change marker", () => {
    expect(parseScope("feat(api)!: drop v1")).toBe("api");
  });

  it("returns null when there is no scope", () => {
    expect(parseScope("fix: a bare fix")).toBeNull();
    expect(parseScope("chore: bump deps")).toBeNull();
  });

  it("returns null for an empty or whitespace scope", () => {
    expect(parseScope("feat(): empty")).toBeNull();
    expect(parseScope("feat(   ): blank")).toBeNull();
  });

  it("returns null for a non-conventional subject", () => {
    expect(parseScope("just a normal commit message")).toBeNull();
    expect(parseScope("")).toBeNull();
  });

  it("trims surrounding whitespace but preserves case (normalization is the caller's job)", () => {
    expect(parseScope("feat( Governance ): x")).toBe("Governance");
  });
});
