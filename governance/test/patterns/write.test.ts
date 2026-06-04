import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializePattern, makeWritePattern } from "../../src/patterns/write.js";
import type { CandidatePattern } from "../../src/patterns/types.js";

const PAT: CandidatePattern = {
  id: "pat_scope_1a2b3c4d",
  kind: "commit_scope_hotspot",
  scope: "governance",
  evidenceCount: 3,
  confidence: 0.3,
  evidenceEventIds: ["evt_commit_a", "evt_commit_b", "evt_commit_c"],
};

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-pat-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("serializePattern", () => {
  it("emits frontmatter fields + a capped evidence list that states the true total", () => {
    const out = serializePattern(PAT, { evidenceCap: 2 });
    expect(out).toContain("kind: commit_scope_hotspot");
    expect(out).toContain("scope: governance");
    expect(out).toContain("status: candidate");
    expect(out).toContain("evidence_count: 3");
    expect(out).toContain("first 2 of 3");
    expect(out).toContain("- evt_commit_a");
    expect(out).not.toContain("- evt_commit_c"); // capped
  });
});

describe("makeWritePattern", () => {
  it("writes a candidate under patterns/candidates/<id>.md and is idempotent", async () => {
    const write = makeWritePattern(ws, { evidenceCap: 20 });
    expect(await write(PAT)).toBe("written");
    const file = join(ws, "patterns", "candidates", "pat_scope_1a2b3c4d.md");
    const first = await readFile(file, "utf8");
    expect(await write(PAT)).toBe("skipped"); // unchanged → skipped
    expect(await readFile(file, "utf8")).toBe(first); // byte-identical
  });

  it("rewrites when evidence changes", async () => {
    const write = makeWritePattern(ws, { evidenceCap: 20 });
    await write(PAT);
    expect(await write({ ...PAT, evidenceCount: 9, confidence: 0.9 })).toBe("written");
    const file = join(ws, "patterns", "candidates", "pat_scope_1a2b3c4d.md");
    expect(await readFile(file, "utf8")).toContain("evidence_count: 9");
  });

  it("never touches patterns/active or patterns/archived", async () => {
    for (const sub of ["active", "archived"]) {
      await mkdir(join(ws, "patterns", sub), { recursive: true });
      await writeFile(join(ws, "patterns", sub, "sentinel.md"), "SENTINEL", "utf8");
    }
    await makeWritePattern(ws, { evidenceCap: 20 })(PAT);
    for (const sub of ["active", "archived"]) {
      expect(await readdir(join(ws, "patterns", sub))).toEqual(["sentinel.md"]);
      expect(await readFile(join(ws, "patterns", sub, "sentinel.md"), "utf8")).toBe("SENTINEL");
    }
  });
});
