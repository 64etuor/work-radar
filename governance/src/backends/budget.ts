import { z } from "zod";

import type { BackendSpec, Provider } from "./config.ts";

export const UNKNOWN_COST = "unknown_cost";
export const DEFAULT_MODEL_KEY = "default";

export interface PriceEntry {
  estimatedTokens: number;
  costPerTokenUsd?: number;
  costPerStepUsd?: number;
}

export type PriceTable = Partial<Record<Provider, Record<string, PriceEntry>>>;

export interface BudgetCaps {
  runTokenCap?: number;
  stepTokenCap?: number;
  runCostCapUsd?: number;
  stepCostCapUsd?: number;
}

export interface BudgetSnapshot {
  spentTokens: number;
  spentCostUsd: number;
}

export type CostEstimate = number | typeof UNKNOWN_COST;

export const budgetCapsSchema = z
  .object({
    runTokenCap: z.number().nonnegative().optional(),
    stepTokenCap: z.number().nonnegative().optional(),
    runCostCapUsd: z.number().nonnegative().optional(),
    stepCostCapUsd: z.number().nonnegative().optional(),
  })
  .strict();

export const priceEntrySchema = z
  .object({
    estimatedTokens: z.number().nonnegative(),
    costPerTokenUsd: z.number().nonnegative().optional(),
    costPerStepUsd: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((entry) => entry.costPerTokenUsd !== undefined || entry.costPerStepUsd !== undefined, {
    message: "price entry requires costPerTokenUsd or costPerStepUsd",
  });

export const priceTableSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), priceEntrySchema),
);

export const DEFAULT_PRICE_TABLE = {
  claude: {
    [DEFAULT_MODEL_KEY]: { estimatedTokens: 20_000, costPerStepUsd: 0.2 },
    "claude-opus-4-1": { estimatedTokens: 40_000, costPerStepUsd: 1.2 },
    "claude-sonnet-4-5": { estimatedTokens: 15_000, costPerStepUsd: 0.3 },
  },
  codex: {
    [DEFAULT_MODEL_KEY]: { estimatedTokens: 5_000, costPerStepUsd: 0.02 },
    "gpt-5-codex-small": { estimatedTokens: 2_000, costPerStepUsd: 0.01 },
  },
  command: {
    [DEFAULT_MODEL_KEY]: { estimatedTokens: 5_000, costPerStepUsd: 0.02 },
    "external-stub": { estimatedTokens: 5_000, costPerStepUsd: 0.02 },
  },
  deterministic: {
    [DEFAULT_MODEL_KEY]: { estimatedTokens: 0, costPerStepUsd: 0 },
  },
} satisfies PriceTable;

export function estimateCost(spec: BackendSpec, priceTable: PriceTable): CostEstimate {
  const entry = priceEntry(spec, priceTable);
  if (!entry) return UNKNOWN_COST;
  if (entry.costPerStepUsd !== undefined) return entry.costPerStepUsd;
  if (entry.costPerTokenUsd !== undefined) return entry.estimatedTokens * entry.costPerTokenUsd;
  return UNKNOWN_COST;
}

export function affordable(
  spec: BackendSpec,
  caps: BudgetCaps | undefined,
  snapshot: BudgetSnapshot,
  priceTable: PriceTable,
): boolean {
  if (!capsActive(caps)) return true;

  const entry = priceEntry(spec, priceTable);
  const cost = estimateCost(spec, priceTable);
  if (!entry || cost === UNKNOWN_COST) return false;

  if (caps.stepTokenCap !== undefined && entry.estimatedTokens > caps.stepTokenCap) return false;
  if (caps.runTokenCap !== undefined && snapshot.spentTokens + entry.estimatedTokens > caps.runTokenCap) {
    return false;
  }
  if (caps.stepCostCapUsd !== undefined && cost > caps.stepCostCapUsd) return false;
  if (caps.runCostCapUsd !== undefined && snapshot.spentCostUsd + cost > caps.runCostCapUsd) {
    return false;
  }
  return true;
}

function capsActive(caps: BudgetCaps | undefined): caps is BudgetCaps {
  if (!caps) return false;
  return (
    caps.runTokenCap !== undefined ||
    caps.stepTokenCap !== undefined ||
    caps.runCostCapUsd !== undefined ||
    caps.stepCostCapUsd !== undefined
  );
}

function priceEntry(spec: BackendSpec, priceTable: PriceTable): PriceEntry | undefined {
  const providerPrices = priceTable[spec.provider];
  if (!providerPrices) return undefined;
  const key = spec.model ?? DEFAULT_MODEL_KEY;
  return providerPrices[key];
}
