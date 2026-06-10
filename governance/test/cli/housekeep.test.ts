import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdHousekeep } from "../../src/cli/boule.js";
import { boulePaths } from "../../src/repo/paths.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import type { GovEvent } from "../../src/event/event.js";

let repo: string;
let stdout: string[];
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boule-housekeep-"));
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

describe("cmdHousekeep", () => {
  it("runs one bounded pass on an empty non-git repo and reports all stages", async () => {
    const code = await cmdHousekeep({ repo, json: true });

    expect(code).toBe(0);
    const report = JSON.parse(stdout.join(""));
    expect(report).toEqual({
      harvested: { written: 0, skipped: 0 },
      detected: { written: 0, skipped: 0, candidates: 0 },
      hypotheses: { proposed: 0, verified: 0, refuted: 0, skipped: 0 },
      proposal: null,
      pruned: {
        hypotheses: { moved: 0, skipped: 0, malformed: 0 },
        patterns: { moved: 0, skipped: 0, malformed: 0 },
      },
    });
  });

  it("writes nothing outside .boule/workspace and never touches decision rails", async () => {
    await cmdHousekeep({ repo, json: true });

    // Repo root gained nothing but .boule (no docs/, no rails, no stray files).
    const rootEntries = (await readdir(repo)).sort();
    expect(rootEntries).toEqual([".boule"]);
    // Empty corpus ⇒ housekeep itself emits no governance events.
    expect(await readAllEvents(boulePaths(repo).workspace)).toEqual([]);
  });

  it("is idempotent: a second pass reports no new writes", async () => {
    await cmdHousekeep({ repo, json: true });
    stdout.length = 0;

    const code = await cmdHousekeep({ repo, json: true });

    expect(code).toBe(0);
    const report = JSON.parse(stdout.join(""));
    expect(report.harvested.written).toBe(0);
    expect(report.detected.written).toBe(0);
    expect(report.hypotheses.proposed).toBe(0);
  });

  it("requires --repo", async () => {
    await expect(cmdHousekeep({})).rejects.toThrow(/--repo/);
  });
});

describe("cmdHousekeep populated corpus", () => {
  it("confines ALL writes to .boule/workspace even when every stage produces output", async () => {
    const ws = boulePaths(repo).workspace;
    // 5 commit events with the same scope = default minEvidence → detect/tester/meta all fire.
    for (let i = 0; i < 5; i++) {
      const event: GovEvent = {
        frontmatter: {
          id: `evt_20260601_10000${i}_000${i}`,
          type: "commit_recorded",
          source: "system",
          actor: "test",
          tags: [],
        },
        body: `feat(news): change ${i}`,
      };
      await writeEvent(ws, event, new Date(Date.UTC(2026, 5, 1, 10, 0, i)));
    }

    await cmdHousekeep({ repo, json: true });
    stdout.length = 0;
    await cmdHousekeep({ repo, json: true }); // second pass: verify + meta proposal + prune

    const report = JSON.parse(stdout.join(""));
    expect(report.hypotheses.verified).toBe(1);
    expect(report.proposal).toMatchObject({ outcome: "written" });
    expect(report.pruned.hypotheses.moved).toBe(1);
    // Everything landed inside workspace/ — .boule gained no sibling dirs, repo root nothing else.
    expect((await readdir(join(repo, ".boule"))).sort()).toEqual(["workspace"]);
    expect((await readdir(repo)).sort()).toEqual([".boule"]);
    expect((await readdir(join(ws, "meta", "proposals"))).length).toBe(1);
  });
});
