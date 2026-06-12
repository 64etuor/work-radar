import {
  assertProviderAllowed,
  type BackendChain,
  type BackendSpec,
  type Provider,
  type Role,
} from "./config.ts";
import { inferDifficulty, type Difficulty, type DifficultySignals } from "./difficulty.ts";
import {
  DEFAULT_PRICE_TABLE,
  affordable,
  type BudgetCaps,
  type BudgetSnapshot,
  type PriceTable,
} from "./budget.ts";
import { exhaustedTerminal, type Terminal } from "./fallback.ts";
import type { ResolvedPolicy } from "../repo/config.ts";

export type { Difficulty };

type Tier = "cheap" | "mid" | "frontier";

export interface ResolveBackendInput {
  difficulty?: Difficulty;
}

export interface ResolveBudgetContext {
  caps?: BudgetCaps;
  snapshot?: BudgetSnapshot;
  priceTable?: PriceTable;
}

export interface ExecutorStepInput extends DifficultySignals {
  text?: string;
  difficulty?: Difficulty;
}

const DEFAULT_DIFFICULTY: Difficulty = "standard";

const TIER_ORDER: Record<Difficulty, Tier[]> = {
  trivial: ["cheap", "mid", "frontier"],
  standard: ["mid", "cheap", "frontier"],
  hard: ["frontier", "mid", "cheap"],
};

const PROVIDER_ORDER: Record<Difficulty, Provider[]> = {
  trivial: ["codex", "command", "claude", "deterministic"],
  standard: ["claude", "codex", "command", "deterministic"],
  hard: ["claude", "codex", "command", "deterministic"],
};

const LEGACY_DEFAULT_BACKENDS: Record<Role, BackendChain> = {
  executor: { chain: [{ provider: "claude" }] },
  reviewer: {
    chain: [
      {
        provider: "command",
        command: "codex",
        args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral"],
        model: "external-stub",
      },
    ],
  },
  evaluator: { chain: [{ provider: "claude" }] },
};

export function resolveBackendChain(
  role: Role,
  input: ResolveBackendInput,
  policy: ResolvedPolicy,
): BackendChain;
export function resolveBackendChain(
  role: Role,
  input: ResolveBackendInput,
  policy: ResolvedPolicy,
  budget: ResolveBudgetContext,
): BackendChain | Terminal;
export function resolveBackendChain(
  role: Role,
  input: ResolveBackendInput,
  policy: ResolvedPolicy,
  budget?: ResolveBudgetContext,
): BackendChain | Terminal {
  const configured = configuredChain(role, policy);
  const candidates = (configured ?? LEGACY_DEFAULT_BACKENDS[role]).chain.map((spec) => ({ ...spec }));
  for (const spec of candidates) assertProviderAllowed(role, spec);

  const difficulty = input.difficulty ?? DEFAULT_DIFFICULTY;
  const ordered = applyRoutingHead(role, orderByDifficulty(candidates, difficulty), difficulty, policy);
  if (!budget) return { chain: ordered };

  const caps = budget.caps ?? policy.budget;
  const snapshot = budget.snapshot ?? { spentTokens: 0, spentCostUsd: 0 };
  const priceTable = budget.priceTable ?? policy.priceTable ?? DEFAULT_PRICE_TABLE;
  const filtered = ordered.filter((spec) => affordable(spec, caps, snapshot, priceTable));
  if (filtered.length === 0) return exhaustedTerminal(role);
  return { chain: filtered };
}

export function selectExecutorChain(
  step: ExecutorStepInput,
  policy: ResolvedPolicy,
): BackendChain;
export function selectExecutorChain(
  step: ExecutorStepInput,
  policy: ResolvedPolicy,
  budget: ResolveBudgetContext,
): BackendChain | Terminal;
export function selectExecutorChain(
  step: ExecutorStepInput,
  policy: ResolvedPolicy,
  budget?: ResolveBudgetContext,
): BackendChain | Terminal {
  const difficulty = step.difficulty ?? inferDifficulty(step);
  if (!budget) return resolveBackendChain("executor", { difficulty }, policy);
  return resolveBackendChain("executor", { difficulty }, policy, budget);
}

function configuredChain(role: Role, policy: ResolvedPolicy): BackendChain | undefined {
  const backends = policy.backends;
  if (!backends) return undefined;
  switch (role) {
    case "executor":
      return backends.executor;
    case "reviewer":
      return backends.reviewers?.[0];
    case "evaluator":
      return backends.evaluator;
  }
}

function orderByDifficulty(candidates: BackendSpec[], difficulty: Difficulty): BackendSpec[] {
  const tierOrder = TIER_ORDER[difficulty];
  const providerOrder = PROVIDER_ORDER[difficulty];
  return candidates
    .map((spec, index) => ({ spec, index }))
    .sort((a, b) => {
      const tierDelta = tierOrder.indexOf(inferTier(a.spec)) - tierOrder.indexOf(inferTier(b.spec));
      if (tierDelta !== 0) return tierDelta;
      const providerDelta =
        providerOrder.indexOf(a.spec.provider) - providerOrder.indexOf(b.spec.provider);
      if (providerDelta !== 0) return providerDelta;
      return a.index - b.index;
    })
    .map(({ spec }) => spec);
}

function applyRoutingHead(
  role: Role,
  ordered: BackendSpec[],
  difficulty: Difficulty,
  policy: ResolvedPolicy,
): BackendSpec[] {
  if (role !== "executor") return ordered;
  const selector = policy.routing?.executor?.[difficulty];
  if (!selector) return ordered;
  const match = ordered.find((spec) => matchesSelector(spec, selector));
  if (!match) return ordered;
  return [match, ...ordered.filter((spec) => spec !== match)];
}

function matchesSelector(spec: BackendSpec, selector: BackendSpec): boolean {
  if (spec.provider !== selector.provider) return false;
  if (selector.model !== undefined && spec.model !== selector.model) return false;
  if (selector.command !== undefined && spec.command !== selector.command) return false;
  return true;
}

function inferTier(spec: BackendSpec): Tier {
  const model = (spec.model ?? "").toLowerCase();
  if (spec.provider === "deterministic") return "cheap";
  if (spec.provider === "command") return modelTier(model) ?? "mid";
  if (spec.provider === "codex" && !model) return "cheap";
  if (spec.provider === "claude" && !model) return "frontier";
  return modelTier(model) ?? "mid";
}

function modelTier(model: string): Tier | null {
  if (!model) return null;
  if (/\b(opus|frontier|max)\b/.test(model)) return "frontier";
  if (/\b(haiku|small|mini|nano|lite|cheap)\b/.test(model)) return "cheap";
  if (/\b(sonnet|mid|standard)\b/.test(model)) return "mid";
  return null;
}
