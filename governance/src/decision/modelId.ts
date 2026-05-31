/** Canonical model id for same-model comparison. Lowercase, trim, collapse internal
 *  whitespace, and strip trailing `@`/`:` version pin segments (idempotent).
 *  Deliberately conservative — does NOT touch internal `-`-separated tokens, so ids like
 *  `claude-opus-4-8` / `gpt-4o` pass through unmangled (over-stripping risks collapsing
 *  two genuinely different models to one id). */
export function normalizeModelId(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  // strip trailing version pin(s): a `@`/`:` separator + optional value, repeatedly → idempotent.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/[@:][^@:\s]*$/, "");
  } while (s !== prev);
  return s;
}
