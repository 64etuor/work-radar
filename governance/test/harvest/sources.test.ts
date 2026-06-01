import { describe, it, expect } from "vitest";
import { commitItem, adrItem, decisionItem } from "../../src/harvest/sources.js";
import { sha256hex } from "../../src/event/id.js";
import type { RawCommit } from "../../src/harvest/gitLog.js";
import type { DecisionRow } from "../../src/index/types.js";

const commit: RawCommit = {
  sha: "a".repeat(40),
  committedAt: new Date(Date.UTC(2026, 5, 1, 9, 8, 7)),
  author: "Alice",
  subject: "feat: thing",
};

const adrRow: DecisionRow = {
  id: "ADR-0007", kind: "adr", title: "Approval Surface", status: "accepted",
  date: "2026-06-01", tags: ["governance"], supersedes: [], refs: ["ADR-0003"],
  excerpt: "…", sourcePath: "docs/adr/0007.md",
};

const dlRow: DecisionRow = {
  id: "DL-005", kind: "decision-log", title: "Some Phase tradeoff", status: undefined,
  date: undefined, tags: [], supersedes: [], refs: [], excerpt: "…",
  sourcePath: "docs/decisions.md",
};

describe("commitItem", () => {
  it("maps a commit to a content-addressed event item", () => {
    const it_ = commitItem(commit);
    expect(it_.id).toBe(`evt_commit_${"a".repeat(40)}`);
    expect(it_.type).toBe("commit_recorded");
    expect(it_.source).toBe("git");
    expect(it_.actor).toBe("Alice");
    expect(it_.body).toBe("feat: thing");
    expect(it_.stampAt).toBe(commit.committedAt);
    expect(it_.dayBucket).toBeUndefined();
    expect(it_.disambiguator).toBe("a".repeat(7));
  });
});

describe("adrItem", () => {
  it("uses the ADR date and carries refs", () => {
    const it_ = adrItem(adrRow);
    expect(it_.id).toBe("evt_adr_ADR-0007");
    expect(it_.type).toBe("decision_proposed");
    expect(it_.source).toBe("adr");
    expect(it_.refs).toEqual(["ADR-0003"]);
    expect(it_.stampAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(it_.dayBucket).toBeUndefined();
    expect(it_.disambiguator).toBe("ADR-0007");
  });
  it("falls back to undated when the ADR has no date", () => {
    const it_ = adrItem({ ...adrRow, date: undefined });
    expect(it_.dayBucket).toBe("undated");
    expect(it_.stampAt.getTime()).toBe(0);
  });
});

describe("decisionItem", () => {
  it("is content-hash based and always undated", () => {
    const it_ = decisionItem(dlRow);
    const key = "some phase tradeoff";
    expect(it_.id).toBe(`evt_decision_${sha256hex(key)}`);
    expect(it_.type).toBe("decision_recorded");
    expect(it_.source).toBe("decisions_doc");
    expect(it_.dayBucket).toBe("undated");
    expect(it_.disambiguator).toBe(sha256hex(key).slice(0, 7));
  });
});
