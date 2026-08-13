import type { GovEvent } from "../event/event.ts";
import type { AutonomyEnvelope, ExecutorKind, SelectedBackendRecord } from "./envelope.ts";
import { type ResolveBudgetContext } from "../backends/resolve.ts";
import { DEFAULT_PRICE_TABLE, reconstructBudgetSnapshot } from "../backends/budget.ts";
import {
  assertProviderAllowed,
  type BackendChain,
  type BackendSpec,
} from "../backends/config.ts";
import { exhaustedTerminal, type Terminal } from "../backends/fallback.ts";
import type { ResolvedPolicy } from "../repo/config.ts";

/** Per-repo policy envelope defaults (spec 2026-06-07 §E). Omitted fields fall back to
 *  buildEnvelope's built-in defaults. */
export interface ConductorEnvelopeDefaults {
  forbiddenDecisionClasses?: AutonomyEnvelope["forbiddenDecisionClasses"];
  allowedType2Actions?: string[];
}

export interface ExecutorViabilityProbes {
  commandExists(command: string): boolean | Promise<boolean>;
  codexAuthAvailable(): boolean | Promise<boolean>;
  ensureCleanCodexHome(): boolean | Promise<boolean>;
}

export interface SelectedExecutorBackend {
  executor: ExecutorKind;
  backend: BackendSpec;
}

export const FAIL_CLOSED_VIABILITY: ExecutorViabilityProbes = {
  commandExists: () => false,
  codexAuthAvailable: () => false,
  ensureCleanCodexHome: () => false,
};

export async function selectViableExecutorBackend(
  resolved: BackendChain | Terminal,
  probes: ExecutorViabilityProbes,
): Promise<SelectedExecutorBackend | Terminal> {
  if (isTerminal(resolved)) return resolved;
  for (const spec of resolved.chain) {
    const executor = await viableExecutorKind(spec, probes);
    if (executor) return { executor, backend: spec };
  }
  return exhaustedTerminal("executor");
}

export async function selectNextViableExecutorBackend(
  chain: BackendChain,
  previous: BackendSpec | SelectedBackendRecord | null,
  probes: ExecutorViabilityProbes,
): Promise<SelectedExecutorBackend | Terminal> {
  const previousIndex = previous
    ? chain.chain.findIndex((spec) => sameBackend(previous, spec))
    : -1;
  for (const spec of chain.chain.slice(previousIndex + 1)) {
    const executor = await viableExecutorKind(spec, probes);
    if (executor) return { executor, backend: spec };
  }
  return exhaustedTerminal("executor");
}

async function viableExecutorKind(
  spec: BackendSpec,
  probes: ExecutorViabilityProbes,
): Promise<ExecutorKind | null> {
  try {
    assertProviderAllowed("executor", spec);
  } catch {
    return null;
  }
  const executor = executorKindForBackend(spec);
  if (!executor) return null;
  if (executor === "claude") return null;
  const command = spec.provider === "command" ? spec.command : executor;
  if (!command || !(await probes.commandExists(command))) return null;
  if (executor !== "codex") return executor;
  if (!(await probes.codexAuthAvailable())) return null;
  if (!(await probes.ensureCleanCodexHome())) return null;
  return executor;
}

function executorKindForBackend(spec: BackendSpec): ExecutorKind | null {
  if (spec.provider === "claude") return "claude";
  if (spec.provider === "codex") return "codex";
  if (spec.provider === "command") return commandProviderExecutor(spec.command);
  return null;
}

function commandProviderExecutor(command: string | undefined): ExecutorKind | null {
  if (command === "claude") return "claude";
  if (command === "codex") return "codex";
  return null;
}

export function selectedBackendRecord(spec: BackendSpec): SelectedBackendRecord {
  return {
    provider: spec.provider,
    ...(spec.model ? { model: spec.model } : {}),
  };
}

export function sameBackend(a: BackendSpec | SelectedBackendRecord | null, b: BackendSpec): boolean {
  if (!a) return false;
  if (a.provider !== b.provider) return false;
  if (a.model !== b.model) return false;
  if (a.provider === "command" && !("command" in a)) return true;
  const command = "command" in a ? a.command : undefined;
  return command === b.command;
}

export function defaultBackendForExecutor(executor: ExecutorKind): SelectedBackendRecord {
  return { provider: executor };
}

export function isTerminal(
  value: BackendChain | Terminal | SelectedExecutorBackend,
): value is Terminal {
  return "role" in value;
}

export function budgetContextFromJournal(
  events: readonly GovEvent[],
  policy: ResolvedPolicy,
  provided: ResolveBudgetContext | undefined,
  excludeTaskId?: string,
): ResolveBudgetContext | undefined {
  if (!provided && !policy.budget) return undefined;

  const caps = provided?.caps ?? policy.budget;
  const priceTable = provided?.priceTable ?? policy.priceTable ?? DEFAULT_PRICE_TABLE;
  const opts = excludeTaskId ? { caps, excludeTaskIds: [excludeTaskId] } : { caps };
  const context: ResolveBudgetContext = {
    snapshot: reconstructBudgetSnapshot(events, priceTable, opts),
    priceTable,
  };
  if (caps) context.caps = caps;
  return context;
}
