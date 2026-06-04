import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import {
  classifyEventRetention,
  classifyPatternRetention,
  readArchivePolicyStatus,
  type ArchivePolicy,
} from "../../src/archive/policy.js";
import type { GovEvent } from "../../src/event/event.js";

const policy: ArchivePolicy = {
  today: "2026-06-04",
  staleEventAgeDays: 30,
  maxEventsPerType: 2,
  stalePatternAgeDays: 14,
  maxCandidatePatternsPerKindScope: 2,
};

function event(id: string, type: GovEvent["frontmatter"]["type"] = "commit_recorded"): GovEvent {
  return { frontmatter: { id, type, source: "git", actor: "u", tags: [] }, body: "Body" };
}

async function seedEvent(ws: string, day: string, id: string, type = "commit_recorded") {
  const dir = join(ws, "events", day);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.md`),
    matter.stringify("Event body.\n", { id, type, source: "git", actor: "u", tags: [] }),
    "utf8",
  );
}

async function seedPattern(
  ws: string,
  subdir: "candidates" | "active" | "archived",
  id: string,
  createdAt: string,
  evidenceCount = 5,
) {
  const dir = join(ws, "patterns", subdir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.md`),
    matter.stringify("Pattern body.\n", {
      id,
      kind: "commit_scope_hotspot",
      scope: "governance",
      evidence_count: evidenceCount,
      confidence: 0.8,
      status: subdir === "candidates" ? "candidate" : subdir,
      created_at: createdAt,
    }),
    "utf8",
  );
}

describe("classifyEventRetention", () => {
  it("marks old overflow events stale while keeping recent and per-type count floor events", () => {
    const rows = [
      event("evt_20260501_090000_0001"),
      event("evt_20260502_090000_0002"),
      event("evt_20260503_090000_0003"),
      event("evt_20260603_090000_0004"),
      event("evt_20260401_090000_0005", "task_created"),
    ];

    const out = classifyEventRetention(rows, policy);
    expect(out.map((r) => [r.id, r.classification, r.reasons])).toEqual([
      ["evt_20260401_090000_0005", "retain", ["age:64d", "count_floor"]],
      ["evt_20260501_090000_0001", "stale", ["age:34d", "count_overflow:commit_recorded"]],
      ["evt_20260502_090000_0002", "retain", ["age:33d", "count_floor"]],
      ["evt_20260503_090000_0003", "retain", ["age:32d", "count_floor"]],
      ["evt_20260603_090000_0004", "retain", ["recent:1d"]],
    ]);
  });
});

describe("classifyPatternRetention", () => {
  it("marks stale candidate overflow patterns but retains curated and count-floor patterns", () => {
    const rows = [
      { id: "pat_old_a", kind: "commit_scope_hotspot", scope: "governance", status: "candidate", createdAt: "2026-05-01", evidenceCount: 3 },
      { id: "pat_old_b", kind: "commit_scope_hotspot", scope: "governance", status: "candidate", createdAt: "2026-05-02", evidenceCount: 4 },
      { id: "pat_old_c", kind: "commit_scope_hotspot", scope: "governance", status: "candidate", createdAt: "2026-05-03", evidenceCount: 5 },
      { id: "pat_active", kind: "commit_scope_hotspot", scope: "governance", status: "active", createdAt: "2026-05-01", evidenceCount: 99 },
    ];

    const out = classifyPatternRetention(rows, policy);
    expect(out.map((r) => [r.id, r.classification, r.reasons])).toEqual([
      ["pat_active", "retain", ["curated:active"]],
      ["pat_old_a", "stale", ["age:34d", "count_overflow:commit_scope_hotspot:governance"]],
      ["pat_old_b", "retain", ["age:33d", "count_floor"]],
      ["pat_old_c", "retain", ["age:32d", "count_floor"]],
    ]);
  });
});

describe("readArchivePolicyStatus", () => {
  it("reads workspace events and patterns without deleting or moving files", async () => {
    const ws = await mkdtemp(join(tmpdir(), "boule-policy-"));
    try {
      await seedEvent(ws, "2026-05-01", "evt_20260501_090000_0001");
      await seedEvent(ws, "2026-05-02", "evt_20260502_090000_0002");
      await seedEvent(ws, "2026-05-03", "evt_20260503_090000_0003");
      await seedPattern(ws, "candidates", "pat_old_a", "2026-05-01");
      await seedPattern(ws, "candidates", "pat_old_b", "2026-05-02");
      await seedPattern(ws, "candidates", "pat_old_c", "2026-05-03");

      const status = await readArchivePolicyStatus(ws, policy);
      expect(status.summary).toEqual({ staleEvents: 1, retainedEvents: 2, stalePatterns: 1, retainedPatterns: 2 });
      expect(status.events.find((r) => r.classification === "stale")?.id).toBe("evt_20260501_090000_0001");
      expect(status.patterns.find((r) => r.classification === "stale")?.id).toBe("pat_old_a");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
