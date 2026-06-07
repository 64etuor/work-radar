import type { DecisionRow } from "./types.ts";
import { dedupe, extractRefs, truncate } from "./text.ts";

// Every decision-log entry is a top-level bullet that opens with a bold title span:
// `- **<title>** <rest>`. Real entries vary after the bold — `: rest`, `. rest`,
// ` (qualifier): rest` — and the `(YYYY-MM-DD)` date (when present) sits inside the
// bold, sometimes with a trailing period. So capture the first bold span as the title
// and treat everything after it as the remainder, rather than requiring a `:`.
const BULLET = /^- \*\*(.+?)\*\*\s*(.*)$/;
// Date at the end of the bold span, tolerating a trailing period (`(2026-05-27).`).
const DATE_SUFFIX = /\((\d{4}-\d{2}-\d{2})\)\.?\s*$/;

/** Parse a decision-log markdown's top-level `- **<title>** <rest>` bullets.
 *  Each match is one row; ids are file-order ordinals (`<idPrefix>-NNN`) since the
 *  log has no formal ids and is append-only. `idPrefix` defaults to `DL` (repo-root
 *  log); the governance-owned log passes `GDL` to avoid id collisions. Non-matching
 *  lines are ignored. */
export function parseDecisionLog(
  content: string,
  sourcePath: string,
  opts: { idPrefix?: string } = {},
): DecisionRow[] {
  const idPrefix = opts.idPrefix ?? "DL";
  const rows: DecisionRow[] = [];
  let ordinal = 0;
  for (const line of content.split("\n")) {
    const m = BULLET.exec(line);
    if (!m) continue;
    ordinal++;
    const bold = m[1].trim();
    const dm = DATE_SUFFIX.exec(bold);
    // Title = the bold span minus a trailing `(date)` and any trailing punctuation.
    const title = (dm ? bold.slice(0, dm.index) : bold).replace(/[.\s]+$/, "").trim();
    // Remainder minus a leading separator (`:`/`.`/space) left over from the bold.
    const rest = m[2].replace(/^[:.\s]+/, "").trim();
    rows.push({
      id: `${idPrefix}-${String(ordinal).padStart(3, "0")}`,
      kind: "decision-log",
      title,
      status: undefined,
      date: dm ? dm[1] : undefined,
      tags: [],
      supersedes: [],
      refs: dedupe(extractRefs(line)),
      excerpt: truncate(rest, 200),
      sourcePath,
    });
  }
  return rows;
}
