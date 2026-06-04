const ADR_REF = /ADR-\d{4}/g;

export function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function extractRefs(s: string): string[] {
  return s.match(ADR_REF) ?? [];
}

export function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

/** First block of consecutive non-blank, non-heading lines, joined with spaces and truncated. */
export function firstParagraph(body: string): string {
  const buf: string[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      if (buf.length) break;
      continue;
    }
    buf.push(t);
  }
  return truncate(buf.join(" "), 200);
}

/** First H1 line, with a leading "N. " ordinal prefix stripped. */
export function adrTitle(body: string): string | null {
  for (const line of body.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].replace(/^\d+\.\s*/, "").trim();
  }
  return null;
}

export function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v == null) return [];
  return [String(v)];
}
