import matter from "gray-matter";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { curatedKeyString } from "./detect.ts";

const SUBDIRS = ["candidates", "active", "archived"] as const;

async function readDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/** Human-curated (active + archived) pattern keys as a normalized `<kind>:<scope>` set.
 *  Tolerant of `.gitkeep` and malformed files. Scope is normalized to match detect.ts. */
export async function loadCuratedKeys(workspaceDir: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const sub of ["active", "archived"]) {
    const dir = join(workspaceDir, "patterns", sub);
    for (const f of await readDir(dir)) {
      try {
        const { data } = matter(await readFile(join(dir, f), "utf8"));
        const kind = data.kind;
        const scope = data.scope;
        if (typeof kind === "string" && typeof scope === "string") {
          keys.add(curatedKeyString(kind, scope.trim().toLowerCase()));
        }
      } catch {
        // malformed → skip
      }
    }
  }
  return keys;
}

export interface PatternView {
  id: string;
  kind: string;
  scope: string;
  evidence_count: number;
  confidence: number;
  status: string;
}

/** List candidate patterns (frontmatter summary), sorted by id for stable output. */
export async function listPatterns(workspaceDir: string): Promise<PatternView[]> {
  const dir = join(workspaceDir, "patterns", "candidates");
  const out: PatternView[] = [];
  for (const f of (await readDir(dir)).sort()) {
    try {
      const { data } = matter(await readFile(join(dir, f), "utf8"));
      out.push({
        id: String(data.id ?? f.replace(/\.md$/, "")),
        kind: String(data.kind ?? ""),
        scope: String(data.scope ?? ""),
        evidence_count: Number(data.evidence_count ?? 0),
        confidence: Number(data.confidence ?? 0),
        status: String(data.status ?? ""),
      });
    } catch {
      // malformed → skip
    }
  }
  return out;
}

/** Find one pattern by id across candidates/active/archived; null if absent. */
export async function getPattern(
  workspaceDir: string,
  id: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string } | null> {
  for (const sub of SUBDIRS) {
    const file = join(workspaceDir, "patterns", sub, `${id}.md`);
    try {
      const { data, content } = matter(await readFile(file, "utf8"));
      return { frontmatter: data as Record<string, unknown>, body: content.trim() };
    } catch {
      // not here → try next
    }
  }
  return null;
}
