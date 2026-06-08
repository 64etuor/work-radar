import { describe, expect, it } from "vitest";

import type { BackendSpec } from "../../src/backends/config.js";
import {
  UNKNOWN_COST,
  affordable,
  estimateCost,
  reconstructBudgetSnapshot,
  type PriceTable,
} from "../../src/backends/budget.js";
import type { GovEvent } from "../../src/event/event.js";

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

function attemptEvent(
  type: "executor_attempt_started" | "executor_attempt_finished",
  id: string,
  taskId: string,
  body: object,
): GovEvent {
  return {
    frontmatter: {
      id,
      type,
      source: type === "executor_attempt_started" ? "hermes" : "agent_run",
      actor: type === "executor_attempt_started" ? "conductor" : "executor",
      tags: ["task", "attempt-hint"],
      related_to: [taskId],
    },
    body: JSON.stringify(body),
  };
}

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

  it("reconstructs unknown executor usage as the reserved estimates, never zero", () => {
    const events = [
      attemptEvent("executor_attempt_started", "evt_1", "task_a", {
        attemptIndex: 0,
        backend: CODEX_SMALL,
      }),
      attemptEvent("executor_attempt_finished", "evt_2", "task_a", {
        attemptIndex: 0,
        outcomeClass: "token_exhausted",
        usage: "unknown",
      }),
      attemptEvent("executor_attempt_started", "evt_3", "task_b", {
        attemptIndex: 0,
        backend: CLAUDE_OPUS,
      }),
      attemptEvent("executor_attempt_finished", "evt_4", "task_b", {
        attemptIndex: 0,
        outcomeClass: "ok",
        usage: "unknown",
      }),
    ];

    expect(reconstructBudgetSnapshot(events, PRICE_TABLE, {})).toEqual({
      spentTokens: 21_000,
      spentCostUsd: 0.601,
    });
  });

  it("reconstructs trusted actual executor usage instead of the reserved estimate", () => {
    const events = [
      attemptEvent("executor_attempt_started", "evt_1", "task_a", {
        attemptIndex: 0,
        backend: CLAUDE_OPUS,
      }),
      attemptEvent("executor_attempt_finished", "evt_2", "task_a", {
        attemptIndex: 0,
        outcomeClass: "ok",
        usage: { tokens: 3_000, costUsd: 0.09 },
      }),
    ];

    expect(reconstructBudgetSnapshot(events, PRICE_TABLE, {})).toEqual({
      spentTokens: 3_000,
      spentCostUsd: 0.09,
    });
  });

  it("reconstructs unknown model cost under active caps as a conservative max, never zero", () => {
    const events = [
      attemptEvent("executor_attempt_started", "evt_1", "task_a", {
        attemptIndex: 0,
        backend: { provider: "claude", model: "missing-model" },
      }),
      attemptEvent("executor_attempt_finished", "evt_2", "task_a", {
        attemptIndex: 0,
        outcomeClass: "fatal",
        usage: "unknown",
      }),
    ];

    expect(
      reconstructBudgetSnapshot(events, PRICE_TABLE, {
        caps: { stepCostCapUsd: 0.25 },
      }),
    ).toEqual({
      spentTokens: 1,
      spentCostUsd: 0.25,
    });
  });

  it("is pure and deterministic for repeated reconstruction inputs", () => {
    const events = [
      attemptEvent("executor_attempt_started", "evt_1", "task_a", {
        attemptIndex: 0,
        backend: CODEX_SMALL,
      }),
    ];
    const before = JSON.stringify(events);

    const first = reconstructBudgetSnapshot(events, PRICE_TABLE, {});
    const second = reconstructBudgetSnapshot(events, PRICE_TABLE, {});

    expect(first).toEqual(second);
    expect(JSON.stringify(events)).toBe(before);
  });
});
