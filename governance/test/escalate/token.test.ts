import { describe, it, expect } from "vitest";
import { mintToken, parseToken, isGovernanceReply } from "../../src/escalate/token.js";

describe("governance option token", () => {
  it("round-trips a well-formed token", () => {
    const t = mintToken("evt_b", "evt_d", "opt1");
    expect(t).toBe("BOULE:evt_b:evt_d:opt1");
    expect(parseToken(t)).toEqual({ blockedEventId: "evt_b", decisionId: "evt_d", optionToken: "opt1" });
  });

  it("parses with surrounding whitespace", () => {
    expect(parseToken("  BOULE:evt_b:evt_d:opt0  ")).toEqual({
      blockedEventId: "evt_b",
      decisionId: "evt_d",
      optionToken: "opt0",
    });
  });

  it("rejects non-token and malformed BOULE strings (exact-shape only)", () => {
    expect(parseToken("sqlite")).toBeNull(); // normal steer
    expect(parseToken("BOULE:")).toBeNull(); // malformed
    expect(parseToken("BOULE:a:b")).toBeNull(); // too few fields
    expect(parseToken("BOULE:a:b:c:d")).toBeNull(); // too many fields
    expect(parseToken("BOULE:a::c")).toBeNull(); // empty field
    expect(parseToken("NOTBOULE:a:b:c")).toBeNull(); // wrong prefix
  });

  it("classifies BOULE-prefixed messages (even malformed) as governance replies", () => {
    expect(isGovernanceReply("BOULE:a:b:c")).toBe(true);
    expect(isGovernanceReply("BOULE:")).toBe(true); // prefixed but malformed → consume, don't forward
    expect(isGovernanceReply("sqlite")).toBe(false); // normal steer → fall through
  });
});
