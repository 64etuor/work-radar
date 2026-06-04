import { describe, expect, it } from "vitest";
import { parseAutoMode } from "../../../src/mcp/config.js";

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
