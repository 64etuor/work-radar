import type { BackendSpec } from "./config.ts";

function clean(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeBackendIdentity(raw: string): string {
  return clean(raw);
}

/** Stable identity for quorum counting: provider plus model when present, otherwise provider.
 *  Command backends without a model use their command name so two identical command reviewers
 *  collapse to one actual reviewer. */
export function backendIdentity(spec: BackendSpec): string {
  const provider = clean(spec.provider);
  if (spec.model) return `${provider}/${clean(spec.model)}`;
  if (spec.provider === "command") return `command/${clean(spec.command ?? "command")}`;
  return provider;
}
