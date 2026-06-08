import { describe, it, expect } from "vitest";

import type { BackendSpec } from "../../src/backends/config.js";
import { resolveBackendChain, type Difficulty } from "../../src/backends/resolve.js";
import type { ResolvedPolicy } from "../../src/repo/config.js";

const BASE_POLICY: ResolvedPolicy = {
  kind: "work",
  autonomyLevel: "manual",
  autoMode: "off",
  reviewQuorum: 2,
  forbiddenDecisionClasses: ["scope"],
  allowedType2Actions: ["edit", "test", "lint"],
};

const MIXED_CHAIN: BackendSpec[] = [
  { provider: "claude", model: "claude-opus-4-1" },
  { provider: "codex", model: "gpt-5-codex-small" },
  { provider: "claude", model: "claude-sonnet-4-5" },
];

function policyWithExecutor(chain: BackendSpec[]): ResolvedPolicy {
  return {
    ...BASE_POLICY,
    backends: { executor: { chain } },
  };
}

function headFor(difficulty: Difficulty): BackendSpec {
  return resolveBackendChain("executor", { difficulty }, policyWithExecutor(MIXED_CHAIN)).chain[0];
}

describe("resolveBackendChain", () => {
  it("trivial difficulty promotes the cheapest codex/small backend to head", () => {
    expect(headFor("trivial")).toEqual({ provider: "codex", model: "gpt-5-codex-small" });
  });

  it("standard difficulty promotes a mid-tier backend to head", () => {
    expect(headFor("standard")).toEqual({ provider: "claude", model: "claude-sonnet-4-5" });
  });

  it("hard difficulty promotes a frontier claude backend to head", () => {
    expect(headFor("hard")).toEqual({ provider: "claude", model: "claude-opus-4-1" });
  });

  it("omitted role backends resolve to the legacy single-backend defaults", () => {
    expect(resolveBackendChain("executor", {}, BASE_POLICY)).toEqual({
      chain: [{ provider: "claude" }],
    });
    expect(resolveBackendChain("reviewer", {}, BASE_POLICY)).toEqual({
      chain: [
        {
          provider: "command",
          command: "codex",
          args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral"],
          model: "external-stub",
        },
      ],
    });
  });

  it("throws when deterministic appears in an executor or reviewer chain", () => {
    expect(() =>
      resolveBackendChain("executor", {}, policyWithExecutor([{ provider: "deterministic" }])),
    ).toThrow(/deterministic/);

    expect(() =>
      resolveBackendChain(
        "reviewer",
        {},
        {
          ...BASE_POLICY,
          backends: { reviewers: [{ chain: [{ provider: "deterministic" }] }] },
        },
      ),
    ).toThrow(/deterministic/);
  });

  it("is pure and deterministic for repeated inputs", () => {
    const policy = policyWithExecutor(MIXED_CHAIN.map((spec) => ({ ...spec })));
    const before = JSON.stringify(policy);

    const first = resolveBackendChain("executor", { difficulty: "hard" }, policy);
    const second = resolveBackendChain("executor", { difficulty: "hard" }, policy);

    expect(first).toEqual(second);
    expect(JSON.stringify(policy)).toBe(before);
    expect(first.chain).not.toBe(policy.backends?.executor?.chain);
  });
});
