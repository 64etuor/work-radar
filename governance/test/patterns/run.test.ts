import { describe, it, expect } from "vitest";
import { runDetect } from "../../src/patterns/detect.js";
import { parsePositiveInt, parsePatternConfig } from "../../src/mcp/config.js";
import type { GovEvent } from "../../src/event/event.js";
import type { CandidatePattern } from "../../src/patterns/types.js";

function commit(id: string, subject: string): GovEvent {
  return {
    frontmatter: { id, type: "commit_recorded", source: "git", actor: "a", tags: [] },
    body: subject,
  };
}

describe("parsePositiveInt", () => {
  it("clamps junk/<1/unset to the default", () => {
    expect(parsePositiveInt("7", 5)).toBe(7);
    expect(parsePositiveInt(undefined, 5)).toBe(5);
    expect(parsePositiveInt("0", 5)).toBe(5);
    expect(parsePositiveInt("-3", 5)).toBe(5);
    expect(parsePositiveInt("abc", 5)).toBe(5);
  });
});

describe("parsePatternConfig", () => {
  it("reads env knobs with safe defaults", () => {
    expect(parsePatternConfig({})).toEqual({ minEvidence: 5, confFull: 50, evidenceCap: 20 });
    expect(
      parsePatternConfig({ BOULE_PATTERN_MIN_EVIDENCE: "3", BOULE_PATTERN_CONF_FULL: "10" }),
    ).toEqual({ minEvidence: 3, confFull: 10, evidenceCap: 20 });
  });
});

describe("runDetect", () => {
  it("wires read → detect → write and returns a summary", async () => {
    const events = [
      commit("evt_commit_1", "feat(governance): a"),
      commit("evt_commit_2", "fix(governance): b"),
      commit("evt_commit_3", "docs(governance): c"),
      commit("evt_commit_4", "fix: bare"),
    ];
    const writes: CandidatePattern[] = [];
    const summary = await runDetect({
      readEvents: async () => events,
      loadCuratedKeys: async () => new Set<string>(),
      writePattern: async (p) => {
        writes.push(p);
        return "written";
      },
      options: { minEvidence: 3, confFull: 10, evidenceCap: 20 },
    });
    expect(summary).toMatchObject({
      written: 1,
      skipped: 0,
      candidates: 1,
      droppedNoScope: 1,
      scopesConsidered: 1,
    });
    expect(writes[0].scope).toBe("governance");
  });

  it("fails soft when readEvents throws (0 patterns, no throw)", async () => {
    const summary = await runDetect({
      readEvents: async () => {
        throw new Error("no events dir");
      },
      loadCuratedKeys: async () => new Set<string>(),
      writePattern: async () => "written",
      options: { minEvidence: 3, confFull: 10, evidenceCap: 20 },
    });
    expect(summary).toMatchObject({ written: 0, candidates: 0 });
  });
});
