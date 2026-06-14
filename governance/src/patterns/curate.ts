import matter from "gray-matter";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Curation transitions for an L1 pattern file. Bounded on purpose:
 *  - activate: candidates → active (human/orchestrator judgment "this pattern is real")
 *  - archive:  candidates|active → archived (demote / forget)
 *  Un-archiving is deliberately NOT a tool — restoring an archived pattern is a rare,
 *  history-sensitive act that stays a manual git operation. */
export type CurateAction = "activate" | "archive";

export type CurateOutcome = "moved" | "already" | "not_found" | "unsafe_id";

export interface CurateResult {
  outcome: CurateOutcome;
  /** subdir the file was found in (when moved) */
  from?: string;
  /** subdir the file now lives in (when moved or already there) */
  to?: string;
}

/** Mirrors read.ts SAFE_ID: the id is an untrusted MCP arg — reject anything that could
 *  carry a path separator before joining it into a path. */
const SAFE_ID = /^[A-Za-z0-9_]+$/;

const TARGET: Record<CurateAction, { sub: string; status: string; sources: string[] }> = {
  activate: { sub: "active", status: "active", sources: ["candidates"] },
  archive: { sub: "archived", status: "archived", sources: ["candidates", "active"] },
};

/** Move one pattern file between lifecycle subdirs, rewriting only its `status`
 *  frontmatter (plus `curated_by`). Idempotent: already in the target dir → "already".
 *  Read→write-target→unlink-source ordering means a crash can leave a duplicate but
 *  never lose the file; loadCuratedKeys treats active+archived as one curated set, so a
 *  stray duplicate cannot resurrect a scope in detection. */
export async function curatePattern(
  workspaceDir: string,
  id: string,
  action: CurateAction,
  actor: string,
): Promise<CurateResult> {
  if (!SAFE_ID.test(id)) return { outcome: "unsafe_id" };
  const target = TARGET[action];
  const targetDir = join(workspaceDir, "patterns", target.sub);
  const targetFile = join(targetDir, `${id}.md`);

  try {
    await readFile(targetFile, "utf8");
    return { outcome: "already", to: target.sub };
  } catch {
    // not in target → look in source dirs
  }

  const sourceReads = await Promise.all(target.sources.map(async (sub) => {
    const sourceFile = join(workspaceDir, "patterns", sub, `${id}.md`);
    try {
      return { sub, sourceFile, raw: await readFile(sourceFile, "utf8") };
    } catch {
      return null;
    }
  }));
  const source = sourceReads.find((candidate) => candidate !== null);
  if (source) {
    const { sub, sourceFile, raw } = source;
    const { data, content } = matter(raw);
    const next = matter.stringify(content, {
      ...data,
      status: target.status,
      curated_by: actor,
    });
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetFile, next, "utf8");
    await unlink(sourceFile);
    return { outcome: "moved", from: sub, to: target.sub };
  }
  return { outcome: "not_found" };
}
