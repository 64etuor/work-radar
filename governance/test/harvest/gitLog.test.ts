import { describe, it, expect } from "vitest";
import { parseGitLog } from "../../src/harvest/gitLog.js";

const US = "\x1f";
const RS = "\x1e";
const rec = (sha: string, iso: string, an: string, subj: string) =>
  [sha, iso, an, subj].join(US) + RS;

describe("parseGitLog", () => {
  it("parses unit/record-separated commits", () => {
    const raw =
      rec("a".repeat(40), "2026-06-01T09:08:07+09:00", "Alice", "feat: x") +
      rec("b".repeat(40), "2026-05-30T12:00:00Z", "Bob", "fix: y");
    const out = parseGitLog(raw);
    expect(out).toHaveLength(2);
    expect(out[0].sha).toBe("a".repeat(40));
    expect(out[0].author).toBe("Alice");
    expect(out[0].subject).toBe("feat: x");
    expect(out[0].committedAt.toISOString()).toBe("2026-06-01T00:08:07.000Z");
  });

  it("skips blank/malformed records and bad dates", () => {
    const raw =
      rec("c".repeat(40), "2026-06-01T00:00:00Z", "C", "ok") +
      "   " + RS +                                   // blank
      ["d".repeat(40), "not-a-date", "D", "z"].join(US) + RS; // bad date
    const out = parseGitLog(raw);
    expect(out.map((c) => c.author)).toEqual(["C"]);
  });
});
