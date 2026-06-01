import type { DecisionRow } from "./types.ts";
import { dedupe, extractRefs, truncate } from "./text.ts";

const BULLET = /^- \*\*(.+?)\*\*:\s*(.*)$/;
const DATE_SUFFIX = /\((\d{4}-\d{2}-\d{2})\)\s*$/;

/** Parse `docs/decisions.md` top-level `- **<title>(<date>)**: <rest>` bullets.
 *  Each match is one row; ids are file-order ordinals (DL-NNN) since the log has
 *  no formal ids and is append-only. Non-matching lines are ignored. */
export function parseDecisionLog(content: string, sourcePath: string): DecisionRow[] {
  const rows: DecisionRow[] = [];
  let ordinal = 0;
  for (const line of content.split("\n")) {
    const m = BULLET.exec(line);
    if (!m) continue;
    ordinal++;
    const bold = m[1].trim();
    const rest = m[2];
    const dm = DATE_SUFFIX.exec(bold);
    rows.push({
      id: `DL-${String(ordinal).padStart(3, "0")}`,
      kind: "decision-log",
      title: dm ? bold.slice(0, dm.index).trim() : bold,
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
