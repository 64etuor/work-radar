/** Conventional-commit header: type, optional (scope), optional `!`, then `:`. */
const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:/;

/** Parse the scope out of a commit subject's first token.
 *  Returns the trimmed scope (case preserved) or null when there is no usable scope.
 *  Normalization (lowercasing) is the caller's responsibility — see detect.ts. */
export function parseScope(subject: string): string | null {
  const m = HEADER.exec(subject.trimStart());
  if (!m) return null;
  const scope = m[2];
  if (scope === undefined) return null; // `fix: ...` — no parenthesized scope
  const trimmed = scope.trim();
  return trimmed.length > 0 ? trimmed : null; // `feat(): ...` — empty scope
}
