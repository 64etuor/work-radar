import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { writeEvent } from "../../src/event/writeEvent.ts";
import { deriveEventId } from "../../src/event/id.ts";
import { readAllEvents } from "../../src/decision/readEvents.ts";
import { makeWriteHypothesis } from "../../src/hypotheses/write.ts";
import {
  listHypotheses,
  readSupportedPatterns,
  readTestingHypotheses,
  runHypothesisTester,
} from "../../src/hypotheses/tester.ts";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-mcp-hyp-"));
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

async function seedPattern() {
  const dir = join(ws, "patterns", "active");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "pat_scope_abcdef12.md"),
    matter.stringify("Curated governance hotspot.\n", {
      id: "pat_scope_abcdef12",
      kind: "commit_scope_hotspot",
      scope: "governance",
      evidence_count: 5,
      confidence: 0.8,
      status: "active",
    }),
    "utf8",
  );
}

describe("hypothesis MCP round-trip", () => {
  it("run_hypothesis_tester writes hypotheses markdown and hypotheses lists it read-only", async () => {
    await seedPattern();
    for (let i = 0; i < 5; i++) {
      await seedCommit(`${i}${"b".repeat(39)}`, `feat(governance): c${i}`, "2026-06-04");
    }

    const deps = {
      readEvents: () => readAllEvents(ws),
      readPatterns: () => readSupportedPatterns(ws),
      readTestingHypotheses: () => readTestingHypotheses(ws),
      writeHypothesis: makeWriteHypothesis(ws),
      now: () => new Date("2026-06-04T00:00:00.000Z"),
    };

    expect(await runHypothesisTester(deps)).toEqual({
      proposed: 1,
      verified: 0,
      refuted: 0,
      skipped: 0,
    });
    expect(await runHypothesisTester(deps)).toEqual({
      proposed: 0,
      verified: 1,
      refuted: 0,
      skipped: 1,
    });

    const list = await listHypotheses(ws);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      from_pattern: "pat_scope_abcdef12",
      kind: "commit_scope_hotspot_persists",
      scope: "governance",
      status: "verified",
    });
  });
});

describe("hypothesis MCP tool surface", () => {
  it("registers P4 tools without adding executor verdict or decision write tools", async () => {
    const source = await readFile(
      join(import.meta.dirname, "../../src/mcp/tools/observation.ts"),
      "utf8",
    );

    expect(source).toContain('"run_hypothesis_tester"');
    expect(source).toContain('"hypotheses"');

    const p4Block = source.slice(
      source.indexOf('"run_hypothesis_tester"'),
      source.indexOf("// ── P5: Meta Observer"),
    );
    expect(p4Block).toContain("runHypothesisTest(");
    expect(p4Block).not.toContain('"approve"');
    expect(p4Block).not.toContain('"reject"');
    expect(p4Block).not.toContain('"choose"');
    expect(p4Block).not.toContain("decision_");
  });
});
