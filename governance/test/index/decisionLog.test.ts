import { describe, it, expect } from "vitest";
import { parseDecisionLog } from "../../src/index/decisionLog.js";

const DOC = `# Decisions

- **First decision(2026-05-23)**: did a thing referencing ADR-0002.
- not an entry bullet
- **Second decision(2026-06-01)**: did another thing.
`;

describe("parseDecisionLog", () => {
  it("parses '- **title(date)**: rest' bullets into ordinal rows", () => {
    const rows = parseDecisionLog(DOC, "docs/decisions.md");
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      id: "DL-001",
      kind: "decision-log",
      title: "First decision",
      date: "2026-05-23",
      tags: [],
      supersedes: [],
      refs: ["ADR-0002"],
      sourcePath: "docs/decisions.md",
    });
    expect(rows[0].excerpt).toContain("did a thing");
    expect(rows[0].status).toBeUndefined();
    expect(rows[1].id).toBe("DL-002");
    expect(rows[1].title).toBe("Second decision");
    expect(rows[1].date).toBe("2026-06-01");
  });

  it("returns [] for content with no matching bullets", () => {
    expect(parseDecisionLog("# Decisions\n\nnothing here", "d.md")).toEqual([]);
  });

  it("handles the real-world bullet variants (period/qualifier, not just colon)", () => {
    const doc = [
      "- **ADR 체계 도입(2026-05-27).** 구조적 결정은 docs/adr 기록.", // date+period inside bold, no colon
      "- **Tailwind v4 채택** (CSS-first): 현재 기본 라인.", // no date, qualifier then colon
      "- **단일 창 토글**: Raycast 모델.", // bold then colon, no date
    ].join("\n");
    const rows = parseDecisionLog(doc, "docs/decisions.md");
    expect(rows.length).toBe(3);

    expect(rows[0]).toMatchObject({ id: "DL-001", title: "ADR 체계 도입", date: "2026-05-27" });
    expect(rows[0].excerpt).toBe("구조적 결정은 docs/adr 기록."); // separator + leading space stripped

    expect(rows[1]).toMatchObject({ id: "DL-002", title: "Tailwind v4 채택" });
    expect(rows[1].date).toBeUndefined();
    expect(rows[1].excerpt).toContain("현재 기본 라인");

    expect(rows[2]).toMatchObject({ id: "DL-003", title: "단일 창 토글" });
    expect(rows[2].excerpt).toBe("Raycast 모델.");
  });
});
