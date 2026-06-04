import type { PrincipleRow } from "./types.ts";

const HEADING = /^##\s+(\d+)\.\s+(.+?)\s*$/;

/** Parse `decision-rails.md` `## N. <title>` sections into INVARIANT-N principles.
 *  Body = lines until the next `## ` heading. Content before the first section
 *  (the `#` title + intro) is ignored. */
export function parseRails(content: string, sourcePath: string): PrincipleRow[] {
  const rows: PrincipleRow[] = [];
  let cur: { number: number; title: string; bodyLines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    rows.push({
      id: `INVARIANT-${cur.number}`,
      number: cur.number,
      title: cur.title,
      body: cur.bodyLines.join("\n").trim(),
      sourcePath,
    });
  };
  for (const line of content.split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      cur = { number: Number(m[1]), title: m[2].trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  flush();
  return rows;
}
