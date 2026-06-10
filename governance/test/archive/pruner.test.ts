import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import type { HypothesisRecord } from "../../src/hypotheses/types.ts";
import { assertSafeArchiveId, runPatternPruner, shouldArchiveHypothesis } from "../../src/archive/pruner.ts";
import { loadCuratedKeys } from "../../src/patterns/read.ts";

function record(overrides: Partial<HypothesisRecord>): HypothesisRecord {
  return {
    id: "hyp_safe",
    fromPattern: "pat_scope_a",
    kind: "commit_scope_hotspot_persists",
    scope: "governance",
    status: "testing",
    testMethod: "current_l0_scope_count",
    baseline: 5,
    threshold: 5,
    expires: "2026-06-04",
    body: "Hypothesis.\n",
    ...overrides,
  };
}

describe("shouldArchiveHypothesis", () => {
  it("archives terminal hypotheses", () => {
    expect(shouldArchiveHypothesis(record({ status: "verified" }), "2026-06-04")).toBe(true);
    expect(shouldArchiveHypothesis(record({ status: "refuted" }), "2026-06-04")).toBe(true);
    expect(shouldArchiveHypothesis(record({ status: "archived" }), "2026-06-04")).toBe(true);
  });

  it("archives only expired testing hypotheses", () => {
    expect(shouldArchiveHypothesis(record({ status: "testing", expires: "2026-06-03" }), "2026-06-04")).toBe(
      true,
    );
    expect(shouldArchiveHypothesis(record({ status: "testing", expires: "2026-06-04" }), "2026-06-04")).toBe(
      false,
    );
    expect(shouldArchiveHypothesis(record({ status: "testing", expires: "2026-06-05" }), "2026-06-04")).toBe(
      false,
    );
  });
});

describe("assertSafeArchiveId", () => {
  it("rejects ids that could escape the archive tree", () => {
    expect(() => assertSafeArchiveId("hyp_safe_123")).not.toThrow();
    expect(() => assertSafeArchiveId("../hyp_bad")).toThrow(/Unsafe hypothesis id/);
    expect(() => assertSafeArchiveId("hyp.bad")).toThrow(/Unsafe hypothesis id/);
  });
});

describe("runPatternPruner", () => {
  const PATTERN = (id: string) =>
    `---\nid: ${id}\nkind: commit_scope_hotspot\nscope: news\nevidence_count: 4\nconfidence: 0.5\nstatus: candidate\n---\nbody\n`;
  const NOW = new Date("2026-06-10T00:00:00Z");
  const OLD = new Date("2026-01-01T00:00:00Z"); // far past the 90d window

  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "boule-pattern-prune-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  async function seedCandidate(id: string, mtime: Date) {
    const dir = join(ws, "patterns", "candidates");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.md`);
    await writeFile(file, PATTERN(id));
    await utimes(file, mtime, mtime);
  }

  it("archives candidates older than the stale window and rewrites status", async () => {
    await seedCandidate("pat_old", OLD);
    await seedCandidate("pat_new", NOW);

    const summary = await runPatternPruner(ws, NOW);

    expect(summary).toEqual({ moved: 1, skipped: 1, malformed: 0 });
    const archived = await readFile(join(ws, "patterns", "archived", "pat_old.md"), "utf8");
    const { data } = matter(archived);
    expect(data.status).toBe("archived");
    expect(data.archived_reason).toBe("stale_candidate");
    // fresh candidate untouched
    await readFile(join(ws, "patterns", "candidates", "pat_new.md"), "utf8");
  });

  it("archived stale candidate joins the curated set (scope not re-detected)", async () => {
    await seedCandidate("pat_old", OLD);
    await runPatternPruner(ws, NOW);

    expect((await loadCuratedKeys(ws)).has("commit_scope_hotspot:news")).toBe(true);
  });

  it("is idempotent and tolerates a pre-existing archived copy", async () => {
    await seedCandidate("pat_old", OLD);
    await runPatternPruner(ws, NOW);
    await seedCandidate("pat_old", OLD); // recreate stale candidate with same id

    const summary = await runPatternPruner(ws, NOW);

    expect(summary).toEqual({ moved: 0, skipped: 1, malformed: 0 });
  });

  it("never touches events or active patterns", async () => {
    await mkdir(join(ws, "patterns", "active"), { recursive: true });
    const activeFile = join(ws, "patterns", "active", "pat_act.md");
    await writeFile(activeFile, PATTERN("pat_act"));
    await utimes(activeFile, OLD, OLD);
    await mkdir(join(ws, "events", "2026-01-01"), { recursive: true });
    await writeFile(join(ws, "events", "2026-01-01", "old.md"), "---\nid: e\n---\n");

    const summary = await runPatternPruner(ws, NOW);

    expect(summary).toEqual({ moved: 0, skipped: 0, malformed: 0 });
    await readFile(activeFile, "utf8"); // still there
    await readFile(join(ws, "events", "2026-01-01", "old.md"), "utf8"); // still there
  });
});
