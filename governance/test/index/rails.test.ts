import { describe, it, expect } from "vitest";
import { parseRails } from "../../src/index/rails.js";

const RAILS = `# Decision Rails — INVARIANTS

intro text before the first section, ignored.

## 1. 결정 레일은 사람만

people only. line two.

## 2. 모든 외부 변경은 Acceptance 게이트

acceptance gate.
`;

describe("parseRails", () => {
  it("splits '## N. title' sections into INVARIANT-N rows", () => {
    const rows = parseRails(RAILS, "docs/areas/decision-rails.md");
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      id: "INVARIANT-1",
      number: 1,
      title: "결정 레일은 사람만",
      sourcePath: "docs/areas/decision-rails.md",
    });
    expect(rows[0].body).toBe("people only. line two.");
    expect(rows[1].id).toBe("INVARIANT-2");
    expect(rows[1].title).toBe("모든 외부 변경은 Acceptance 게이트");
  });

  it("returns [] when there are no numbered sections", () => {
    expect(parseRails("# Title\n\njust prose", "r.md")).toEqual([]);
  });
});
