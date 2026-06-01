import { describe, it, expect } from "vitest";
import { parseQuorum, parseReviewerArgs, parseReviewerModels } from "../../src/mcp/config.js";

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

describe("parseReviewerArgs", () => {
  it("defaults to a read-only, repo-agnostic, ephemeral codex exec (safe-by-default)", () => {
    for (const v of [undefined, "", "   "]) {
      expect(parseReviewerArgs(v)).toEqual([
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
      ]);
    }
  });
  it("honors an explicit override verbatim (operator opts into their own sandbox)", () => {
    expect(parseReviewerArgs("exec --sandbox workspace-write")).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
    ]);
  });
  it("collapses extra whitespace between tokens", () => {
    expect(parseReviewerArgs("exec   --json")).toEqual(["exec", "--json"]);
  });
});
