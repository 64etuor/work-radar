import { readdir as nodeReaddir, readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionRow, GovernanceIndex, PrincipleRow } from "./types.ts";
import { parseAdr } from "./adr.ts";
import { parseDecisionLog } from "./decisionLog.ts";
import { parseRails } from "./rails.ts";
import { DEFAULT_INDEX_SOURCES, type IndexSources } from "./sources.ts";

export interface IndexFs {
  /** Returns file contents, or null if missing/unreadable. */
  readFile(path: string): Promise<string | null>;
  /** Returns entry names in a directory, or [] if missing/unreadable. */
  readDir(path: string): Promise<string[]>;
}

/** Real filesystem adapter — fail-soft (missing path → null / []). */
export const nodeIndexFs: IndexFs = {
  async readFile(path) {
    try {
      return await nodeReadFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async readDir(path) {
    try {
      return await nodeReaddir(path);
    } catch {
      return [];
    }
  },
};

const SKIP_ADR = new Set(["ADR-0000-template.md", "README.md"]);

function pushEdge(m: Map<string, string[]>, key: string, value: string): void {
  const arr = m.get(key);
  if (arr) arr.push(value);
  else m.set(key, [value]);
}

/** Build the in-memory governance index from the repo's L3/L4 markdown.
 *  markdown is SSOT; this derived structure is rebuilt by calling buildIndex again.
 *  `sources` is the (additive, fail-soft) discovery config — default reads both the
 *  repo-root app L3/L4 and the governance-owned L3/L4 (see DEFAULT_INDEX_SOURCES). */
export async function buildIndex(
  repoRoot: string,
  fs: IndexFs,
  sources: IndexSources = DEFAULT_INDEX_SOURCES,
): Promise<GovernanceIndex> {
  const decisions: DecisionRow[] = [];
  // ADR ids must be globally unique across every ADR dir; a silent Map overwrite
  // would hide a real authoring mistake, so a collision is a hard error.
  const adrIdSource = new Map<string, string>();

  for (const src of sources.decisionSources) {
    if (src.kind === "adr-dir") {
      const adrDir = join(repoRoot, src.dir);
      const names = (await fs.readDir(adrDir)).filter((n) => n.endsWith(".md") && !SKIP_ADR.has(n));
      names.sort();
      for (const name of names) {
        const content = await fs.readFile(join(adrDir, name));
        if (content == null) continue;
        const row = parseAdr(content, `${src.sourcePathPrefix}/${name}`);
        if (!row) continue;
        const prior = adrIdSource.get(row.id);
        if (prior !== undefined) {
          throw new Error(`Duplicate ADR id ${row.id}: ${row.sourcePath} collides with ${prior}`);
        }
        adrIdSource.set(row.id, row.sourcePath);
        decisions.push(row);
      }
    } else {
      const content = await fs.readFile(join(repoRoot, src.file));
      if (content != null) {
        decisions.push(...parseDecisionLog(content, src.sourcePath, { idPrefix: src.idPrefix }));
      }
    }
  }

  const principles: PrincipleRow[] = [];
  for (const src of sources.principleSources) {
    const content = await fs.readFile(join(repoRoot, src.file));
    if (content != null) principles.push(...parseRails(content, src.sourcePath));
  }

  const supersededBy = new Map<string, string[]>();
  const referencedBy = new Map<string, string[]>();
  for (const d of decisions) {
    for (const s of d.supersedes) pushEdge(supersededBy, s, d.id);
    for (const r of d.refs) pushEdge(referencedBy, r, d.id);
  }
  const byId = new Map(decisions.map((d) => [d.id, d]));

  return {
    decisions,
    principles,
    getDecision: (id) => {
      const row = byId.get(id);
      if (!row) return null;
      return {
        row,
        supersededBy: supersededBy.get(id) ?? [],
        referencedBy: referencedBy.get(id) ?? [],
      };
    },
  };
}
