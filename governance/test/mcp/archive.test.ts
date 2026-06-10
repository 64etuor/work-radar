import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { archiveStatus, runArchivePruner } from "../../src/archive/pruner.ts";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-archive-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

async function seedTesting(id: string, status: "testing" | "verified" | "refuted", expires: string, body = "Body.\n") {
  const dir = join(ws, "hypotheses", "testing");
  await mkdir(dir, { recursive: true });
  const raw = matter.stringify(body, {
    id,
    from_pattern: "pat_scope_a",
    kind: "commit_scope_hotspot_persists",
    scope: "governance",
    status,
    test_method: "current_l0_scope_count",
    baseline: 5,
    threshold: 5,
    expires,
  });
  await writeFile(join(dir, `${id}.md`), raw, "utf8");
  return raw;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("archive pruner IO", () => {
  it("moves terminal and expired hypotheses, preserves raw bytes, and is idempotent", async () => {
    const refutedRaw = await seedTesting("hyp_refuted", "refuted", "2026-06-10", "Refuted raw body.\n");
    const expiredRaw = await seedTesting("hyp_expired", "testing", "2026-06-03", "Expired raw body.\n");
    await seedTesting("hyp_keep", "testing", "2026-06-04", "Keep raw body.\n");

    expect(await runArchivePruner(ws, "2026-06-04")).toEqual({ moved: 2, skipped: 1, malformed: 0 });
    expect(await readFile(join(ws, "hypotheses", "archived", "hyp_refuted.md"), "utf8")).toBe(refutedRaw);
    expect(await readFile(join(ws, "hypotheses", "archived", "hyp_expired.md"), "utf8")).toBe(expiredRaw);
    expect(await exists(join(ws, "hypotheses", "testing", "hyp_refuted.md"))).toBe(false);
    expect(await exists(join(ws, "hypotheses", "testing", "hyp_keep.md"))).toBe(true);

    expect(await runArchivePruner(ws, "2026-06-04")).toEqual({ moved: 0, skipped: 1, malformed: 0 });
    expect(await archiveStatus(ws)).toEqual({
      testing: 1,
      archived: 2,
      pattern_candidates: 0,
      pattern_active: 0,
      pattern_archived: 0,
    });
  });

  it("keeps an existing archived file and unlinks the testing duplicate", async () => {
    await seedTesting("hyp_same", "refuted", "2026-06-10", "new testing body\n");
    const archivedDir = join(ws, "hypotheses", "archived");
    await mkdir(archivedDir, { recursive: true });
    await writeFile(join(archivedDir, "hyp_same.md"), "old archived body\n", "utf8");

    expect(await runArchivePruner(ws, "2026-06-04")).toEqual({ moved: 0, skipped: 1, malformed: 0 });
    expect(await readFile(join(archivedDir, "hyp_same.md"), "utf8")).toBe("old archived body\n");
    expect(await exists(join(ws, "hypotheses", "testing", "hyp_same.md"))).toBe(false);
  });
});

describe("archive MCP tool surface", () => {
  it("registers P6 archive tools without decision or unrelated write surfaces", async () => {
    const source = await readFile(join(import.meta.dirname, "../../src/mcp/server.ts"), "utf8");

    expect(source).toContain("// ── P6: Archive Pruner");
    expect(source).toContain('"archive_prune"');
    expect(source).toContain('"archive_status"');

    const p6Block = source.slice(
      source.indexOf("// ── P6: Archive Pruner"),
      source.indexOf("// ── Phase C: Conductor"),
    );
    expect(p6Block).not.toContain('"approve"');
    expect(p6Block).not.toContain('"choose"');
    expect(p6Block).not.toContain("decision_");
    expect(p6Block).not.toContain("decision-rails");
    expect(p6Block).not.toContain("writeEvent");
    expect(p6Block).not.toContain("makeWritePattern");
  });
});
