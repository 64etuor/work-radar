import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import type { HypothesisRecord } from "../hypotheses/types.ts";
import { isTerminalHypothesisStatus, parseHypothesisMarkdown } from "../hypotheses/hypothesis.ts";

const SAFE_ID = /^[A-Za-z0-9_]+$/;

/** Candidate patterns nobody curated within this window are presumed noise and archived
 *  (the forgetting loop). Archived patterns join the curated set, so the same scope is not
 *  re-detected — un-archiving stays a manual git operation. */
export const STALE_PATTERN_DAYS = 90;

export interface ArchivePrunerSummary {
  moved: number;
  skipped: number;
  malformed: number;
}

export interface ArchiveStatus {
  testing: number;
  archived: number;
  pattern_candidates: number;
  pattern_active: number;
  pattern_archived: number;
}

export function shouldArchiveHypothesis(record: HypothesisRecord, today: string): boolean {
  if (isTerminalHypothesisStatus(record.status)) return true;
  return record.status === "testing" && record.expires < today;
}

export function assertSafeArchiveId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(`Unsafe hypothesis id: ${id}`);
  }
}

export async function runArchivePruner(workspaceDir: string, today: string): Promise<ArchivePrunerSummary> {
  const testingDir = join(workspaceDir, "hypotheses", "testing");
  const archivedDir = join(workspaceDir, "hypotheses", "archived");
  await mkdir(archivedDir, { recursive: true });

  let files: string[] = [];
  try {
    files = (await readdir(testingDir)).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return { moved: 0, skipped: 0, malformed: 0 };
  }

  const summary: ArchivePrunerSummary = { moved: 0, skipped: 0, malformed: 0 };
  for (const file of files) {
    const src = join(testingDir, file);
    let raw = "";
    let record: HypothesisRecord;
    try {
      raw = await readFile(src, "utf8");
      record = parseHypothesisMarkdown(raw);
      assertSafeArchiveId(record.id);
    } catch {
      summary.malformed++;
      continue;
    }

    if (!shouldArchiveHypothesis(record, today)) {
      summary.skipped++;
      continue;
    }

    const dest = join(archivedDir, `${record.id}.md`);
    if (await exists(dest)) {
      await unlink(src);
      summary.skipped++;
      continue;
    }

    await writeFile(dest, raw, "utf8");
    await unlink(src);
    summary.moved++;
  }
  return summary;
}

/** Archive candidate patterns whose file is older than `staleDays` (mtime-based — the
 *  candidate file is rewritten only when its content changes, so mtime ≈ last evidence
 *  movement). Rewrites status→archived with an archived_reason, writes to
 *  patterns/archived/, then unlinks the candidate. Events are deliberately NOT pruned:
 *  every Control Room / orchestrator fold replays the full L0 log, so moving events
 *  would silently change live state (deviation from the original design's §5.4).
 *  Pattern files under active/ are human-curated and never auto-archived. */
export async function runPatternPruner(
  workspaceDir: string,
  now: Date,
  staleDays: number = STALE_PATTERN_DAYS,
): Promise<ArchivePrunerSummary> {
  const candidatesDir = join(workspaceDir, "patterns", "candidates");
  const archivedDir = join(workspaceDir, "patterns", "archived");
  const cutoffMs = now.getTime() - staleDays * 24 * 60 * 60 * 1000;

  let files: string[] = [];
  try {
    files = (await readdir(candidatesDir)).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return { moved: 0, skipped: 0, malformed: 0 };
  }

  const summary: ArchivePrunerSummary = { moved: 0, skipped: 0, malformed: 0 };
  for (const file of files) {
    const src = join(candidatesDir, file);
    const id = file.replace(/\.md$/, "");
    if (!SAFE_ID.test(id)) {
      summary.malformed++;
      continue;
    }
    let raw = "";
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(src)).mtimeMs;
      raw = await readFile(src, "utf8");
    } catch {
      summary.malformed++;
      continue;
    }
    if (mtimeMs >= cutoffMs) {
      summary.skipped++;
      continue;
    }

    const dest = join(archivedDir, file);
    if (await exists(dest)) {
      await unlink(src);
      summary.skipped++;
      continue;
    }
    let next = raw;
    try {
      const { data, content } = matter(raw);
      next = matter.stringify(content, {
        ...data,
        status: "archived",
        archived_reason: "stale_candidate",
      });
    } catch {
      summary.malformed++;
      continue;
    }
    await mkdir(archivedDir, { recursive: true });
    await writeFile(dest, next, "utf8");
    await unlink(src);
    summary.moved++;
  }
  return summary;
}

export async function archiveStatus(workspaceDir: string): Promise<ArchiveStatus> {
  return {
    testing: await countMarkdown(join(workspaceDir, "hypotheses", "testing")),
    archived: await countMarkdown(join(workspaceDir, "hypotheses", "archived")),
    pattern_candidates: await countMarkdown(join(workspaceDir, "patterns", "candidates")),
    pattern_active: await countMarkdown(join(workspaceDir, "patterns", "active")),
    pattern_archived: await countMarkdown(join(workspaceDir, "patterns", "archived")),
  };
}

async function countMarkdown(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
