import { describe, it, expect } from "vitest";

import type { BackendSpec } from "../../src/backends/config.js";
import { resolveBackendChain, type Difficulty } from "../../src/backends/resolve.js";
import type { ResolvedPolicy } from "../../src/repo/config.js";
import type { PriceTable } from "../../src/backends/budget.js";

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

  it("keeps M3 behavior byte-for-byte when budget context is absent", () => {
    const policy = policyWithExecutor(MIXED_CHAIN);
    const noBudget = resolveBackendChain("executor", { difficulty: "hard" }, policy);

    expect(noBudget).toEqual({
      chain: [
        { provider: "claude", model: "claude-opus-4-1" },
        { provider: "claude", model: "claude-sonnet-4-5" },
        { provider: "codex", model: "gpt-5-codex-small" },
      ],
    });
  });

  it("filters unaffordable candidates after difficulty ordering so a cheaper codex backend becomes head", () => {
    const priceTable: PriceTable = {
      claude: {
        "claude-opus-4-1": { estimatedTokens: 40_000, costPerStepUsd: 1.2 },
        "claude-sonnet-4-5": { estimatedTokens: 15_000, costPerStepUsd: 0.3 },
      },
      codex: {
        "gpt-5-codex-small": { estimatedTokens: 2_000, costPerStepUsd: 0.01 },
      },
    };

    const resolved = resolveBackendChain("executor", { difficulty: "hard" }, policyWithExecutor(MIXED_CHAIN), {
      caps: { stepCostCapUsd: 0.05 },
      snapshot: { spentTokens: 0, spentCostUsd: 0 },
      priceTable,
    });

    expect(resolved).toEqual({
      chain: [{ provider: "codex", model: "gpt-5-codex-small" }],
    });
  });

  it("returns the role-correct terminal when every budget-filtered candidate is unaffordable", () => {
    const priceTable: PriceTable = {
      claude: {
        "claude-opus-4-1": { estimatedTokens: 40_000, costPerStepUsd: 1.2 },
        "claude-sonnet-4-5": { estimatedTokens: 15_000, costPerStepUsd: 0.3 },
      },
      codex: {
        "gpt-5-codex-small": { estimatedTokens: 2_000, costPerStepUsd: 0.01 },
      },
    };

    const resolved = resolveBackendChain("executor", { difficulty: "hard" }, policyWithExecutor(MIXED_CHAIN), {
      caps: { stepCostCapUsd: 0.001 },
      snapshot: { spentTokens: 0, spentCostUsd: 0 },
      priceTable,
    });

    expect(resolved).toEqual({ role: "executor", outcome: "stall" });
  });

  it("does not treat unknown model cost as free while caps are active", () => {
    const resolved = resolveBackendChain(
      "executor",
      { difficulty: "hard" },
      policyWithExecutor([{ provider: "claude", model: "missing-model" }]),
      {
        caps: { runCostCapUsd: 100 },
        snapshot: { spentTokens: 0, spentCostUsd: 0 },
        priceTable: {},
      },
    );

    expect(resolved).toEqual({ role: "executor", outcome: "stall" });
  });

  it("budget filtering never lowers quorum or changes acceptance policy", () => {
    const policy = policyWithExecutor(MIXED_CHAIN);
    const before = JSON.stringify(policy);

    resolveBackendChain("executor", { difficulty: "hard" }, policy, {
      caps: { stepCostCapUsd: 0.001 },
      snapshot: { spentTokens: 0, spentCostUsd: 0 },
      priceTable: {},
    });

    expect(policy.reviewQuorum).toBe(2);
    expect(policy.autonomyLevel).toBe("manual");
    expect(policy.autoMode).toBe("off");
    expect(JSON.stringify(policy)).toBe(before);
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
