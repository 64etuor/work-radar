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
  const groups = await Promise.all(["active", "archived"].map(async (sub) => {
    const dir = join(workspaceDir, "patterns", sub);
    return Promise.all((await readDir(dir)).map(async (f) => {
      try {
        const { data } = matter(await readFile(join(dir, f), "utf8"));
        const kind = data.kind;
        const scope = data.scope;
        if (typeof kind === "string" && typeof scope === "string") {
          return curatedKeyString(kind, scope.trim().toLowerCase());
        }
      } catch {
        // malformed → skip
      }
      return null;
    }));
  }));
  for (const key of groups.flat()) {
    if (key !== null) keys.add(key);
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

export type PatternSubdir = (typeof SUBDIRS)[number];

/** List patterns across the given subdirs (frontmatter summary), sorted by id within each
 *  subdir for stable output. `status` reflects the file's frontmatter, not the subdir. */
export async function listPatternsIn(
  workspaceDir: string,
  subdirs: readonly PatternSubdir[],
): Promise<PatternView[]> {
  const groups = await Promise.all(subdirs.map(async (sub) => {
    const dir = join(workspaceDir, "patterns", sub);
    return Promise.all((await readDir(dir)).sort().map(async (f) => {
      try {
        const { data } = matter(await readFile(join(dir, f), "utf8"));
        return {
          id: String(data.id ?? f.replace(/\.md$/, "")),
          kind: String(data.kind ?? ""),
          scope: String(data.scope ?? ""),
          evidence_count: Number(data.evidence_count ?? 0),
          confidence: Number(data.confidence ?? 0),
          status: String(data.status ?? ""),
        };
      } catch {
        // malformed → skip
      }
      return null;
    }));
  }));
  return groups.flat().filter((pattern): pattern is PatternView => pattern !== null);
}

/** List candidate patterns (frontmatter summary), sorted by id for stable output. */
export async function listPatterns(workspaceDir: string): Promise<PatternView[]> {
  return listPatternsIn(workspaceDir, ["candidates"]);
}

/** Safe pattern-id shape: alphanumerics + underscore only. Rejects any id with a path
 *  separator or `.` (so `../` traversal can never escape the patterns/ tree). Covers the
 *  current `pat_scope_<8hex>` ids and any future `<prefix>_<...>` alnum/underscore id. */
const SAFE_ID = /^[A-Za-z0-9_]+$/;

/** Find one pattern by id across candidates/active/archived; null if absent or unsafe.
 *  SECURITY: `id` is an untrusted MCP arg — validate before joining it into a path. */
export async function getPattern(
  workspaceDir: string,
  id: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string } | null> {
  if (!SAFE_ID.test(id)) return null; // path-traversal / out-of-tree read guard
  const reads = await Promise.all(SUBDIRS.map(async (sub) => {
    const file = join(workspaceDir, "patterns", sub, `${id}.md`);
    try {
      const { data, content } = matter(await readFile(file, "utf8"));
      return { frontmatter: data as Record<string, unknown>, body: content.trim() };
    } catch {
      return null;
    }
  }));
  return reads.find((pattern) => pattern !== null) ?? null;
}
