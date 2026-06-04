import { describe, expect, it } from "vitest";
import type { GovEvent } from "../../src/event/event.ts";
import type { HypothesisRecord } from "../../src/hypotheses/types.ts";
import {
  evaluateHypothesis,
  hypothesisFromPattern,
  hypothesisId,
  runHypothesisTester,
  type SupportedPattern,
} from "../../src/hypotheses/tester.ts";

function commit(id: string, subject: string): GovEvent {
  return {
    frontmatter: { id, type: "commit_recorded", source: "git", actor: "a", tags: [] },
    body: subject,
  };
}

const pattern: SupportedPattern = {
  id: "pat_scope_abcdef12",
  kind: "commit_scope_hotspot",
  scope: "governance",
  evidenceCount: 5,
};

describe("hypothesis tester pure core", () => {
  it("generates a deterministic testing hypothesis from a commit-scope hotspot", () => {
    const hypothesis = hypothesisFromPattern(pattern, { expires: "2026-07-04" });

    expect(hypothesis.id).toBe(hypothesisId("pat_scope_abcdef12"));
    expect(hypothesis).toMatchObject({
      fromPattern: "pat_scope_abcdef12",
      kind: "commit_scope_hotspot_persists",
      scope: "governance",
      status: "testing",
      testMethod: "current_l0_scope_count",
      baseline: 5,
      threshold: 5,
      expires: "2026-07-04",
    });
  });

  it("verifies a hypothesis when current L0 commit scope count reaches threshold", () => {
    const hypothesis = hypothesisFromPattern(pattern, { expires: "2026-07-04" });
    const events = [
      commit("evt_1", "feat(governance): a"),
      commit("evt_2", "fix(governance): b"),
      commit("evt_3", "docs(governance): c"),
      commit("evt_4", "test(governance): d"),
      commit("evt_5", "refactor(governance): e"),
      commit("evt_6", "feat(other): ignored"),
    ];

    expect(evaluateHypothesis(hypothesis, events).status).toBe("verified");
  });

  it("refutes a hypothesis when current L0 commit scope count is below threshold", () => {
    const hypothesis = hypothesisFromPattern(pattern, { expires: "2026-07-04" });
    const events = [commit("evt_1", "feat(governance): a"), commit("evt_2", "fix(other): ignored")];

    expect(evaluateHypothesis(hypothesis, events).status).toBe("refuted");
  });
});

describe("runHypothesisTester", () => {
  it("proposes supported hypotheses and evaluates testing hypotheses", async () => {
    const existing: HypothesisRecord = hypothesisFromPattern(
      { ...pattern, id: "pat_scope_existing", scope: "docs" },
      { expires: "2026-07-04" },
    );
    const writes: HypothesisRecord[] = [];

    const summary = await runHypothesisTester({
      readEvents: async () => [
        commit("evt_1", "feat(governance): a"),
        commit("evt_2", "fix(governance): b"),
        commit("evt_3", "docs(governance): c"),
        commit("evt_4", "test(governance): d"),
        commit("evt_5", "refactor(governance): e"),
        commit("evt_6", "feat(docs): a"),
        commit("evt_7", "fix(docs): b"),
        commit("evt_8", "docs(docs): c"),
        commit("evt_9", "test(docs): d"),
        commit("evt_10", "refactor(docs): e"),
      ],
      readPatterns: async () => [pattern],
      readTestingHypotheses: async () => [existing],
      writeHypothesis: async (record) => {
        writes.push(record);
        return "written";
      },
      now: () => new Date("2026-06-04T00:00:00.000Z"),
    });

    expect(summary).toEqual({ proposed: 1, verified: 1, refuted: 0, skipped: 0 });
    expect(writes.map((record) => record.status)).toEqual(["testing", "verified"]);
  });
});
