import { describe, it, expect } from "vitest";
import {
  parseQuorum,
  parseReviewerArgs,
  parseReviewerModels,
  reviewerEnvSuffix,
  resolveReviewerCommand,
  reviewerIdentity,
  quorumCollisionWarning,
} from "../../src/mcp/config.js";

const SAFE_ARGS = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral"];

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

describe("reviewerEnvSuffix", () => {
  it("upper-cases and collapses non-alnum runs to a single underscore", () => {
    expect(reviewerEnvSuffix("codex")).toBe("CODEX");
    expect(reviewerEnvSuffix("gemini")).toBe("GEMINI");
    expect(reviewerEnvSuffix("claude-opus-4-8")).toBe("CLAUDE_OPUS_4_8");
    expect(reviewerEnvSuffix("gpt-4o")).toBe("GPT_4O");
  });
  it("trims surrounding whitespace and leading/trailing separators", () => {
    expect(reviewerEnvSuffix("  codex  ")).toBe("CODEX");
    expect(reviewerEnvSuffix("claude:latest")).toBe("CLAUDE_LATEST");
    expect(reviewerEnvSuffix("-gemini-")).toBe("GEMINI");
  });
  it("yields an empty suffix for degenerate labels (no usable env key — falls back to globals)", () => {
    expect(reviewerEnvSuffix("---")).toBe("");
    expect(reviewerEnvSuffix("")).toBe("");
  });
});

describe("resolveReviewerCommand", () => {
  it("prefers the per-model command + args (most specific wins)", () => {
    const env = {
      BOULE_REVIEWER_CMD_CODEX: "codex-bin",
      BOULE_REVIEWER_ARGS_CODEX: "exec --json",
      BOULE_REVIEWER_CMD: "global-bin",
    };
    expect(resolveReviewerCommand("codex", env)).toEqual({
      command: "codex-bin",
      args: ["exec", "--json"],
    });
  });
  it("falls back to the global command + args when no per-model override", () => {
    const env = { BOULE_REVIEWER_CMD: "global-bin", BOULE_REVIEWER_ARGS: "exec --foo" };
    expect(resolveReviewerCommand("gemini", env)).toEqual({
      command: "global-bin",
      args: ["exec", "--foo"],
    });
  });
  it("falls back to default codex + safe read-only args when nothing is set", () => {
    expect(resolveReviewerCommand("anything", {})).toEqual({
      command: "codex",
      args: SAFE_ARGS,
    });
  });
  it("applies the safe-args default per model when only the model command is named", () => {
    const env = { BOULE_REVIEWER_CMD_CLAUDE: "claude" };
    expect(resolveReviewerCommand("claude", env)).toEqual({
      command: "claude",
      args: SAFE_ARGS,
    });
  });
});

describe("reviewerIdentity", () => {
  it("is stable for equal command + args", () => {
    expect(reviewerIdentity({ command: "codex", args: ["exec"] })).toBe(
      reviewerIdentity({ command: "codex", args: ["exec"] }),
    );
  });
  it("differs when the command differs", () => {
    expect(reviewerIdentity({ command: "codex", args: ["exec"] })).not.toBe(
      reviewerIdentity({ command: "claude", args: ["exec"] }),
    );
  });
  it("differs when the args differ", () => {
    expect(reviewerIdentity({ command: "codex", args: ["exec"] })).not.toBe(
      reviewerIdentity({ command: "codex", args: ["exec", "--json"] }),
    );
  });
});

describe("quorumCollisionWarning", () => {
  it("returns null when quorum is 1 (no genuine-quorum requirement)", () => {
    expect(quorumCollisionWarning(["codex", "gemini"], {}, 1)).toBeNull();
  });
  it("returns null when distinct reviewers meet the quorum", () => {
    const env = { BOULE_REVIEWER_CMD_CODEX: "codex", BOULE_REVIEWER_CMD_CLAUDE: "claude" };
    expect(quorumCollisionWarning(["codex", "claude"], env, 2)).toBeNull();
  });
  it("returns null when a genuine quorum is still reachable despite one collision", () => {
    // codex + gemini collapse to the default, but claude is distinct → 2 distinct >= quorum 2
    const env = { BOULE_REVIEWER_CMD_CLAUDE: "claude" };
    expect(quorumCollisionWarning(["codex", "gemini", "claude"], env, 2)).toBeNull();
  });
  it("warns when labels collapse below the quorum, naming the colliding labels", () => {
    const msg = quorumCollisionWarning(["codex", "gemini"], {}, 2);
    expect(msg).not.toBeNull();
    expect(msg).toContain("codex");
    expect(msg).toContain("gemini");
  });
  it("never leaks args content into the warning (PII-safe — labels only)", () => {
    const env = { BOULE_REVIEWER_ARGS: "exec --secret-token abc123" };
    const msg = quorumCollisionWarning(["codex", "gemini"], env, 2);
    expect(msg).not.toContain("--sandbox");
    expect(msg).not.toContain("read-only");
    expect(msg).not.toContain("abc123");
  });
  it("names each colliding group separately when distinct collisions exist", () => {
    // codex+gemini collapse to default; foo+bar collapse to a shared override → 2 groups, 2 distinct < quorum 3
    const env = { BOULE_REVIEWER_CMD_FOO: "shared", BOULE_REVIEWER_CMD_BAR: "shared" };
    const msg = quorumCollisionWarning(["codex", "gemini", "foo", "bar"], env, 3);
    expect(msg).not.toBeNull();
    for (const label of ["codex", "gemini", "foo", "bar"]) expect(msg).toContain(label);
    expect(msg).toContain(";"); // groups are separated
  });
});
