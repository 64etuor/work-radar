import { describe, it, expect } from "vitest";
import { ingest, isType1Candidate, type RawActivity } from "../../src/gateway/gateway.js";

const now = new Date(Date.UTC(2026, 4, 16, 14, 32, 18));

describe("ingest", () => {
  it("maps a git commit to commit_recorded/git", () => {
    const raw: RawActivity = { kind: "git_commit", actor: "64etuor", summary: "feat: x", tags: ["git"] };
    const e = ingest(raw, now, 0.64);
    expect(e.frontmatter.type).toBe("commit_recorded");
    expect(e.frontmatter.source).toBe("git");
    expect(e.frontmatter.id).toBe("evt_20260516_143218_a3d7");
    expect(e.body).toBe("feat: x");
  });

  it("maps an added ADR to decision_proposed/adr", () => {
    const e = ingest({ kind: "adr_added", actor: "user", summary: "ADR-0007" }, now, 0);
    expect(e.frontmatter.type).toBe("decision_proposed");
    expect(e.frontmatter.source).toBe("adr");
  });

  it("throws on unknown kind", () => {
    expect(() => ingest({ kind: "bogus" as any, actor: "x", summary: "y" }, now, 0)).toThrow(/unknown activity kind/);
  });
});

describe("isType1Candidate", () => {
  it("flags decision_proposed events", () => {
    const e = ingest({ kind: "adr_added", actor: "user", summary: "ADR-0007" }, now, 0);
    expect(isType1Candidate(e)).toBe(true);
  });
  it("does not flag commit events", () => {
    const e = ingest({ kind: "git_commit", actor: "x", summary: "y" }, now, 0);
    expect(isType1Candidate(e)).toBe(false);
  });
});
