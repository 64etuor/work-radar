import matter from "gray-matter";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HypothesisRecord } from "./types.ts";

export type WriteOutcome = "written" | "skipped";

const SAFE_ID = /^[A-Za-z0-9_]+$/;

export function serializeHypothesis(record: HypothesisRecord): string {
  return matter.stringify(record.body, {
    id: record.id,
    from_pattern: record.fromPattern,
    kind: record.kind,
    scope: record.scope,
    status: record.status,
    test_method: record.testMethod,
    baseline: record.baseline,
    threshold: record.threshold,
    expires: record.expires,
  });
}

/** WRITE-PATH INVARIANT: Slice 1 writes only hypotheses/testing/<id>.md. */
export function makeWriteHypothesis(workspaceDir: string): (record: HypothesisRecord) => Promise<WriteOutcome> {
  const dir = join(workspaceDir, "hypotheses", "testing");
  return async (record) => {
    if (!SAFE_ID.test(record.id)) {
      throw new Error(`Unsafe hypothesis id: ${record.id}`);
    }
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${record.id}.md`);
    const next = serializeHypothesis(record);
    try {
      if ((await readFile(file, "utf8")) === next) return "skipped";
    } catch {
      // missing -> write
    }
    await writeFile(file, next, "utf8");
    return "written";
  };
}
