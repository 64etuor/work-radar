import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDetect } from "../../src/patterns/detect.js";
import { makeWritePattern } from "../../src/patterns/write.js";
import { loadCuratedKeys, listPatterns, getPattern } from "../../src/patterns/read.js";
import { parsePatternConfig } from "../../src/mcp/config.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { deriveEventId } from "../../src/event/id.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-mcp-pat-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

async function seedCommit(sha: string, subject: string, day: string) {
  await writeEvent(
    ws,
    {
      frontmatter: {
        id: deriveEventId("commit", sha),
        type: "commit_recorded",
        source: "git",
        actor: "a",
        tags: [],
      },
      body: subject,
    },
    new Date(`${day}T00:00:00Z`),
    { disambiguator: sha.slice(0, 7) },
  );
}

describe("pattern MCP round-trip", () => {
  it("detect → patterns → pattern, idempotent on re-run", async () => {
    for (let i = 0; i < 5; i++) {
      // distinct index at the FRONT so disambiguator = sha.slice(0,7) is unique per commit
      await seedCommit(`${i}${"a".repeat(39)}`, `feat(governance): c${i}`, "2026-06-02");
    }

    const cfg = parsePatternConfig({});
    const deps = {
      readEvents: () => readAllEvents(ws),
      loadCuratedKeys: () => loadCuratedKeys(ws),
      writePattern: makeWritePattern(ws, { evidenceCap: cfg.evidenceCap }),
      options: cfg,
    };

    const run1 = await runDetect(deps);
    expect(run1.written).toBe(1);
    expect(run1.candidates).toBe(1);

    const list = await listPatterns(ws);
    expect(list).toHaveLength(1);
    expect(list[0].scope).toBe("governance");
    expect(list[0].evidence_count).toBe(5);

    const detail = await getPattern(ws, list[0].id);
    expect(detail?.body).toContain("Evidence (first 5 of 5)");

    const run2 = await runDetect(deps); // re-run on unchanged corpus
    expect(run2.written).toBe(0); // idempotent
    expect(run2.skipped).toBe(1);
  });
});
