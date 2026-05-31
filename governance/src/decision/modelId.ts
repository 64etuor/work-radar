/** Canonical model id for same-model comparison. Lowercase, trim, collapse internal
 *  whitespace, and strip a single explicit trailing version pin (`@<ver>` or `:<ver>`).
 *  Deliberately conservative — does NOT touch internal `-`-separated tokens, so ids like
 *  `claude-opus-4-8` / `gpt-4o` pass through unmangled (over-stripping risks collapsing
 *  two genuinely different models to one id). */
export function normalizeModelId(raw: string): string {
  const collapsed = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return collapsed.replace(/[@:][^@:\s]+$/, "");
}
