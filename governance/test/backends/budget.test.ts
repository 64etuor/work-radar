import { describe, expect, it } from "vitest";

import type { BackendSpec } from "../../src/backends/config.js";
import {
  UNKNOWN_COST,
  affordable,
  estimateCost,
  type PriceTable,
} from "../../src/backends/budget.js";

const CODEX_SMALL: BackendSpec = { provider: "codex", model: "gpt-5-codex-small" };
const CLAUDE_OPUS: BackendSpec = { provider: "claude", model: "claude-opus-4-1" };

const PRICE_TABLE: PriceTable = {
  codex: {
    "gpt-5-codex-small": { estimatedTokens: 1_000, costPerTokenUsd: 0.000001 },
  },
  claude: {
    "claude-opus-4-1": { estimatedTokens: 20_000, costPerStepUsd: 0.6 },
  },
};

describe("budget helpers", () => {
  it("estimateCost returns deterministic known costs or an explicit unknown sentinel", () => {
    expect(estimateCost(CODEX_SMALL, PRICE_TABLE)).toBe(0.001);
    expect(estimateCost(CLAUDE_OPUS, PRICE_TABLE)).toBe(0.6);
    expect(estimateCost({ provider: "claude", model: "missing-model" }, PRICE_TABLE)).toBe(
      UNKNOWN_COST,
    );
  });

  it("affordable applies run and step token/cost caps without mutating its inputs", () => {
    const caps = { runTokenCap: 3_000, stepTokenCap: 1_500, runCostCapUsd: 0.01, stepCostCapUsd: 0.002 };
    const snapshot = { spentTokens: 1_500, spentCostUsd: 0.001 };
    const tableBefore = JSON.stringify(PRICE_TABLE);

    const first = affordable(CODEX_SMALL, caps, snapshot, PRICE_TABLE);
    const second = affordable(CODEX_SMALL, caps, snapshot, PRICE_TABLE);

    expect(first).toBe(true);
    expect(second).toBe(first);
    expect(affordable(CLAUDE_OPUS, caps, snapshot, PRICE_TABLE)).toBe(false);
    expect(JSON.stringify(PRICE_TABLE)).toBe(tableBefore);
  });

  it("treats unknown cost as unaffordable when any cap is active", () => {
    const missing = { provider: "claude", model: "missing-model" } satisfies BackendSpec;

    expect(
      affordable(missing, { runCostCapUsd: 1 }, { spentTokens: 0, spentCostUsd: 0 }, PRICE_TABLE),
    ).toBe(false);
    expect(affordable(missing, {}, { spentTokens: 0, spentCostUsd: 0 }, PRICE_TABLE)).toBe(true);
  });
});
