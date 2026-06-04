import { readdir as nodeReaddir, readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionRow, GovernanceIndex, PrincipleRow } from "./types.ts";
import { parseAdr } from "./adr.ts";
import { parseDecisionLog } from "./decisionLog.ts";
import { parseRails } from "./rails.ts";

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
 *  markdown is SSOT; this derived structure is rebuilt by calling buildIndex again. */
export async function buildIndex(repoRoot: string, fs: IndexFs): Promise<GovernanceIndex> {
  const decisions: DecisionRow[] = [];

  const adrDir = join(repoRoot, "docs", "adr");
  const names = (await fs.readDir(adrDir)).filter((n) => n.endsWith(".md") && !SKIP_ADR.has(n));
  names.sort();
  for (const name of names) {
    const content = await fs.readFile(join(adrDir, name));
    if (content == null) continue;
    const row = parseAdr(content, `docs/adr/${name}`);
    if (row) decisions.push(row);
  }

  const decisionsDoc = await fs.readFile(join(repoRoot, "docs", "decisions.md"));
  if (decisionsDoc != null) decisions.push(...parseDecisionLog(decisionsDoc, "docs/decisions.md"));

  const railsDoc = await fs.readFile(join(repoRoot, "docs", "areas", "decision-rails.md"));
  const principles: PrincipleRow[] =
    railsDoc != null ? parseRails(railsDoc, "docs/areas/decision-rails.md") : [];

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
