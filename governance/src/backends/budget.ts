import { z } from "zod";

import { backendSpecSchema, type BackendSpec, type Provider } from "./config.ts";
import type { GovEvent } from "../event/event.ts";

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

export interface ReconstructBudgetSnapshotOptions {
  caps?: BudgetCaps;
  maxUnknownCostUsd?: number;
  maxUnknownTokens?: number;
  excludeTaskIds?: readonly string[];
}

export const budgetCapsSchema = z
  .object({
    runTokenCap: z.number().nonnegative().optional(),
    stepTokenCap: z.number().nonnegative().optional(),
    runCostCapUsd: z.number().nonnegative().optional(),
    stepCostCapUsd: z.number().nonnegative().optional(),
  })
  .strict();

const priceEntrySchema = z
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

const DEFAULT_UNKNOWN_ATTEMPT_COST_USD = 1;
const DEFAULT_UNKNOWN_ATTEMPT_TOKENS = 1;

const trustedUsageSchema = z
  .object({
    tokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((usage) => usage.tokens !== undefined || usage.costUsd !== undefined, {
    message: "trusted usage requires tokens or costUsd",
  });

const attemptStartedBodySchema = z
  .object({
    attemptIndex: z.number().int().nonnegative(),
    backend: backendSpecSchema,
  })
  .passthrough();

const attemptFinishedBodySchema = z
  .object({
    attemptIndex: z.number().int().nonnegative(),
    usage: z.union([z.literal("unknown"), trustedUsageSchema]).optional(),
  })
  .passthrough();

type TrustedUsage = z.infer<typeof trustedUsageSchema>;

export function estimateCost(spec: BackendSpec, priceTable: PriceTable): CostEstimate {
  const entry = priceEntry(spec, priceTable);
  if (!entry) return UNKNOWN_COST;
  if (entry.costPerStepUsd !== undefined) return entry.costPerStepUsd;
  if (entry.costPerTokenUsd !== undefined) return entry.estimatedTokens * entry.costPerTokenUsd;
  return UNKNOWN_COST;
}

export function estimateTokens(spec: BackendSpec, priceTable: PriceTable): number | undefined {
  return priceEntry(spec, priceTable)?.estimatedTokens;
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

export function reconstructBudgetSnapshot(
  events: readonly GovEvent[],
  priceTable: PriceTable,
  opts: ReconstructBudgetSnapshotOptions = {},
): BudgetSnapshot {
  const excluded = new Set(opts.excludeTaskIds ?? []);
  const attempts = new Map<string, { backend?: BackendSpec; usage?: TrustedUsage | "unknown" }>();

  for (const event of events) {
    const taskId = primaryTaskId(event);
    if (taskId && excluded.has(taskId)) continue;

    if (event.frontmatter.type === "executor_attempt_started") {
      const parsed = attemptStartedBodySchema.safeParse(safeJson(event.body));
      if (!parsed.success || !taskId) continue;
      const key = attemptKey(taskId, parsed.data.attemptIndex);
      attempts.set(key, {
        ...(attempts.get(key) ?? {}),
        backend: parsed.data.backend,
      });
      continue;
    }

    if (event.frontmatter.type === "executor_attempt_finished") {
      const parsed = attemptFinishedBodySchema.safeParse(safeJson(event.body));
      if (!parsed.success || !taskId) continue;
      const key = attemptKey(taskId, parsed.data.attemptIndex);
      attempts.set(key, {
        ...(attempts.get(key) ?? {}),
        usage: parsed.data.usage ?? "unknown",
      });
    }
  }

  let spentTokens = 0;
  let spentCostUsd = 0;
  for (const attempt of attempts.values()) {
    const spend =
      attempt.usage && attempt.usage !== "unknown"
        ? trustedSpend(attempt.usage, attempt.backend, priceTable, opts)
        : reservedSpend(attempt.backend, priceTable, opts);
    spentTokens += spend.spentTokens;
    spentCostUsd += spend.spentCostUsd;
  }

  return { spentTokens, spentCostUsd };
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

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function primaryTaskId(event: GovEvent): string | null {
  return event.frontmatter.related_to?.[0] ?? null;
}

function attemptKey(taskId: string, attemptIndex: number): string {
  return `${taskId}\u0000${attemptIndex}`;
}

function reservedSpend(
  backend: BackendSpec | undefined,
  priceTable: PriceTable,
  opts: ReconstructBudgetSnapshotOptions,
): BudgetSnapshot {
  if (!backend) return conservativeUnknownSpend(opts);
  const cost = estimateCost(backend, priceTable);
  return {
    spentTokens: estimateTokens(backend, priceTable) ?? conservativeUnknownTokens(opts),
    spentCostUsd: cost === UNKNOWN_COST ? conservativeUnknownCost(opts) : cost,
  };
}

function trustedSpend(
  usage: TrustedUsage,
  backend: BackendSpec | undefined,
  priceTable: PriceTable,
  opts: ReconstructBudgetSnapshotOptions,
): BudgetSnapshot {
  const tokens = usage.tokens ?? 0;
  const costUsd =
    usage.costUsd ??
    actualCostFromTokens(tokens, backend, priceTable) ??
    reservedSpend(backend, priceTable, opts).spentCostUsd;
  return {
    spentTokens: tokens,
    spentCostUsd: costUsd,
  };
}

function actualCostFromTokens(
  tokens: number,
  backend: BackendSpec | undefined,
  priceTable: PriceTable,
): number | undefined {
  if (!backend) return undefined;
  const entry = priceEntry(backend, priceTable);
  if (entry?.costPerTokenUsd === undefined) return undefined;
  return tokens * entry.costPerTokenUsd;
}

function conservativeUnknownSpend(opts: ReconstructBudgetSnapshotOptions): BudgetSnapshot {
  return {
    spentTokens: conservativeUnknownTokens(opts),
    spentCostUsd: conservativeUnknownCost(opts),
  };
}

function conservativeUnknownTokens(opts: ReconstructBudgetSnapshotOptions): number {
  return firstPositive([
    opts.maxUnknownTokens,
    opts.caps?.stepTokenCap,
    opts.caps?.runTokenCap,
    DEFAULT_UNKNOWN_ATTEMPT_TOKENS,
  ]);
}

function conservativeUnknownCost(opts: ReconstructBudgetSnapshotOptions): number {
  return firstPositive([
    opts.maxUnknownCostUsd,
    opts.caps?.stepCostCapUsd,
    opts.caps?.runCostCapUsd,
    DEFAULT_UNKNOWN_ATTEMPT_COST_USD,
  ]);
}

function firstPositive(values: readonly (number | undefined)[]): number {
  return values.find((value) => value !== undefined && value > 0) ?? 0;
}
