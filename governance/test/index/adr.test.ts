import { describe, it, expect } from "vitest";
import { parseAdr } from "../../src/index/adr.js";

const ADR = `---
adr-id: ADR-0007
status: accepted
date: 2026-06-01
tags: [governance, acp]
supersedes: [ADR-0003]
---

# 0007. Governance Surface

## Context

**Scope**: the sidecar. Relates to ADR-0006 and ADR-0007 (self).
`;

describe("parseAdr", () => {
  it("parses frontmatter, title, refs, supersedes (self-ref excluded)", () => {
    const row = parseAdr(ADR, "docs/adr/0007-x.md");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("ADR-0007");
    expect(row!.kind).toBe("adr");
    expect(row!.title).toBe("Governance Surface");
    expect(row!.status).toBe("accepted");
    expect(row!.date).toBe("2026-06-01");
    expect(row!.tags).toEqual(["governance", "acp"]);
    expect(row!.supersedes).toEqual(["ADR-0003"]);
    expect(row!.refs).toEqual(["ADR-0006"]); // self ADR-0007 excluded, deduped
    expect(row!.excerpt).toContain("**Scope**: the sidecar.");
    expect(row!.sourcePath).toBe("docs/adr/0007-x.md");
  });

  it("returns null when frontmatter has no adr-id", () => {
    expect(parseAdr("# no frontmatter here", "docs/adr/README.md")).toBeNull();
    expect(parseAdr("---\nstatus: draft\n---\n# body", "x.md")).toBeNull();
  });

  it("treats an empty supersedes as []", () => {
    const row = parseAdr("---\nadr-id: ADR-0001\nsupersedes:\n---\n# 1. T\n\nbody", "a.md");
    expect(row!.supersedes).toEqual([]);
  });
});
