import { describe, expect, it } from "vitest";
import {
  parseAutoMode,
  parseConductorExecutor,
  parseEnvelopeDefaults,
} from "../../../src/mcp/config.js";

describe("parseAutoMode (opt-in, fail-closed to off)", () => {
  it("returns type2 only for exactly type2, ignoring case and surrounding space", () => {
    expect(parseAutoMode("type2")).toBe("type2");
    expect(parseAutoMode("  TYPE2 ")).toBe("type2");
  });

  it("defaults to off for unset, blank, or junk values", () => {
    expect(parseAutoMode(undefined)).toBe("off");
    expect(parseAutoMode("")).toBe("off");
    expect(parseAutoMode("on")).toBe("off");
    expect(parseAutoMode("type1")).toBe("off");
    expect(parseAutoMode("true")).toBe("off");
  });
});

describe("parseConductorExecutor (L3 — safe default is sandboxed codex)", () => {
  it("preserves an explicit claude request for the live adapter to reject", () => {
    expect(parseConductorExecutor("claude")).toBe("claude");
    expect(parseConductorExecutor("  CLAUDE ")).toBe("claude");
  });

  it("defaults to codex for unset, blank, codex, or junk values", () => {
    expect(parseConductorExecutor(undefined)).toBe("codex");
    expect(parseConductorExecutor("")).toBe("codex");
    expect(parseConductorExecutor("codex")).toBe("codex");
    expect(parseConductorExecutor("gemini")).toBe("codex");
  });
});

describe("parseEnvelopeDefaults (per-repo policy → envelope, fail-safe)", () => {
  it("parses valid comma lists", () => {
    const d = parseEnvelopeDefaults({
      BOULE_ENVELOPE_FORBIDDEN_CLASSES: "scope,security",
      BOULE_ENVELOPE_ALLOWED_TYPE2: "edit,refactor",
    });
    expect(d.forbiddenDecisionClasses).toEqual(["scope", "security"]);
    expect(d.allowedType2Actions).toEqual(["edit", "refactor"]);
  });

  it("drops unknown decision classes (never widens with garbage)", () => {
    const d = parseEnvelopeDefaults({ BOULE_ENVELOPE_FORBIDDEN_CLASSES: "scope,made-up,security" });
    expect(d.forbiddenDecisionClasses).toEqual(["scope", "security"]);
  });

  it("omits fields when unset (⇒ conductor built-in defaults apply)", () => {
    expect(parseEnvelopeDefaults({})).toEqual({});
  });
});
