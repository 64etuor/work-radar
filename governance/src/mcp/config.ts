import { normalizeModelId } from "../decision/modelId.ts";

/** Parse BOULE_REVIEW_QUORUM into a positive integer. Junk / <1 / unset → 1.
 *  Fail-closed: an unparseable quorum must never silently LOWER the bar below 1. */
export function parseQuorum(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Parse BOULE_REVIEWER_MODELS (comma list) → trimmed, non-empty, deduped-by-normalized-id
 *  model labels (first spelling of each normalized id wins). Falls back to [fallback] when
 *  the list is unset or empty. */
export function parseReviewerModels(raw: string | undefined, fallback: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const label = part.trim();
    if (!label) continue;
    const key = normalizeModelId(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.length > 0 ? out : [fallback];
}
