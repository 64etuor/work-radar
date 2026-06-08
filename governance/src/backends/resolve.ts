import {
  assertProviderAllowed,
  type BackendChain,
  type BackendSpec,
  type Provider,
  type Role,
} from "./config.ts";
import type { ResolvedPolicy } from "../repo/config.ts";

export type Difficulty = "trivial" | "standard" | "hard";

type Tier = "cheap" | "mid" | "frontier";

export interface ResolveBackendInput {
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

export const LEGACY_DEFAULT_BACKENDS: Record<Role, BackendChain> = {
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
): BackendChain {
  const configured = configuredChain(role, policy);
  const candidates = (configured ?? LEGACY_DEFAULT_BACKENDS[role]).chain.map((spec) => ({ ...spec }));
  for (const spec of candidates) assertProviderAllowed(role, spec);

  const difficulty = input.difficulty ?? DEFAULT_DIFFICULTY;
  return { chain: orderByDifficulty(candidates, difficulty) };
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
