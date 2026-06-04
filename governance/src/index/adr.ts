import matter from "gray-matter";
import type { DecisionRow } from "./types.ts";
import { adrTitle, dedupe, extractRefs, firstParagraph, toStringArray } from "./text.ts";

/** Parse one ADR markdown file. Returns null for files without a usable `adr-id`
 *  frontmatter field (template, README, or a stray doc) — the caller skips them. */
export function parseAdr(content: string, sourcePath: string): DecisionRow | null {
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(content);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    return null;
  }
  const id = typeof data["adr-id"] === "string" ? (data["adr-id"] as string) : null;
  if (!id) return null;

  const supersedes = dedupe(toStringArray(data.supersedes).flatMap(extractRefs));
  const refs = dedupe(extractRefs(body)).filter((r) => r !== id);

  // gray-matter may parse `date: 2026-06-01` as a JS Date object
  let date: string | undefined;
  if (data.date != null) {
    if (data.date instanceof Date) {
      date = data.date.toISOString().slice(0, 10);
    } else {
      date = String(data.date);
    }
  }

  return {
    id,
    kind: "adr",
    title: adrTitle(body) ?? id,
    status: typeof data.status === "string" ? data.status : undefined,
    date,
    tags: toStringArray(data.tags),
    supersedes,
    refs,
    excerpt: firstParagraph(body),
    sourcePath,
  };
}
