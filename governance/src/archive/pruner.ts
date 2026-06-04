import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HypothesisRecord } from "../hypotheses/types.ts";
import { isTerminalHypothesisStatus, parseHypothesisMarkdown } from "../hypotheses/hypothesis.ts";

const SAFE_ID = /^[A-Za-z0-9_]+$/;

export interface ArchivePrunerSummary {
  moved: number;
  skipped: number;
  malformed: number;
}

export interface ArchiveStatus {
  testing: number;
  archived: number;
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

export async function archiveStatus(workspaceDir: string): Promise<ArchiveStatus> {
  return {
    testing: await countMarkdown(join(workspaceDir, "hypotheses", "testing")),
    archived: await countMarkdown(join(workspaceDir, "hypotheses", "archived")),
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
