import { describe, it, expect } from "vitest";
import { patternId, confidence, detectPatterns } from "../../src/patterns/detect.js";
import type { GovEvent } from "../../src/event/event.js";

function commit(id: string, subject: string): GovEvent {
  return {
    frontmatter: { id, type: "commit_recorded", source: "git", actor: "alice", tags: [] },
    body: subject,
  };
}

const OPTS = { minEvidence: 3, confFull: 10, evidenceCap: 20 };

describe("patternId", () => {
  it("is namespace-scoped and stable (sha8 of `<kind>:<scope>`)", () => {
    const a = patternId("governance");
    expect(a).toMatch(/^pat_scope_[0-9a-f]{8}$/);
    expect(patternId("governance")).toBe(a); // deterministic
    expect(patternId("plan")).not.toBe(a); // scope-sensitive
  });
});

describe("confidence", () => {
  it("is count/confFull, clamped to 1, rounded to 2dp", () => {
    expect(confidence(5, 10)).toBe(0.5);
    expect(confidence(10, 10)).toBe(1);
    expect(confidence(99, 10)).toBe(1); // clamp
    expect(confidence(1, 3)).toBe(0.33); // round
  });
});

describe("detectPatterns", () => {
  it("emits a candidate for a scope at/over the threshold, dropping under-threshold scopes", () => {
    const events = [
      commit("evt_commit_1", "feat(governance): a"),
      commit("evt_commit_2", "fix(governance): b"),
      commit("evt_commit_3", "docs(governance): c"),
      commit("evt_commit_4", "feat(news): d"), // 1 < threshold 3
    ];
    const r = detectPatterns(events, new Set(), OPTS);
    expect(r.patterns).toHaveLength(1);
    expect(r.patterns[0]).toMatchObject({
      kind: "commit_scope_hotspot",
      scope: "governance",
      evidenceCount: 3,
      id: patternId("governance"),
    });
    expect(r.patterns[0].evidenceEventIds).toEqual(["evt_commit_1", "evt_commit_2", "evt_commit_3"]);
    expect(r.scopesConsidered).toBe(2); // governance + news
  });

  it("merges case/whitespace variants of a scope onto one normalized key", () => {
    const events = [
      commit("evt_commit_1", "feat(Governance): a"),
      commit("evt_commit_2", "fix( governance ): b"),
      commit("evt_commit_3", "docs(GOVERNANCE): c"),
    ];
    const r = detectPatterns(events, new Set(), OPTS);
    expect(r.patterns).toHaveLength(1);
    expect(r.patterns[0].scope).toBe("governance");
    expect(r.patterns[0].evidenceCount).toBe(3);
  });

  it("counts commits with no scope as droppedNoScope and ignores non-commit events", () => {
    const events: GovEvent[] = [
      commit("evt_commit_1", "fix: bare"),
      commit("evt_commit_2", "not conventional at all"),
      {
        frontmatter: {
          id: "evt_decision_x",
          type: "decision_recorded",
          source: "decisions_doc",
          actor: "system",
          tags: [],
        },
        body: "feat(governance): looks like a scope but is a decision",
      },
    ];
    const r = detectPatterns(events, new Set(), OPTS);
    expect(r.patterns).toHaveLength(0);
    expect(r.droppedNoScope).toBe(2);
    expect(r.scopesConsidered).toBe(0);
  });

  it("skips a scope already curated by a human (active or archived)", () => {
    const events = [
      commit("evt_commit_1", "feat(governance): a"),
      commit("evt_commit_2", "fix(governance): b"),
      commit("evt_commit_3", "docs(governance): c"),
    ];
    const curated = new Set(["commit_scope_hotspot:governance"]);
    const r = detectPatterns(events, curated, OPTS);
    expect(r.patterns).toHaveLength(0);
    expect(r.scopesConsidered).toBe(1); // still considered, just not emitted
  });

  it("returns patterns sorted by scope (byte-stable)", () => {
    const mk = (scope: string, n: number) =>
      Array.from({ length: n }, (_, i) => commit(`evt_${scope}_${i}`, `feat(${scope}): x`));
    const events = [...mk("zeta", 3), ...mk("alpha", 3)];
    const r = detectPatterns(events, new Set(), OPTS);
    expect(r.patterns.map((p) => p.scope)).toEqual(["alpha", "zeta"]);
  });
});
