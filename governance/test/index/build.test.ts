import { describe, it, expect } from "vitest";
import { buildIndex, type IndexFs } from "../../src/index/build.js";
import { join } from "node:path";

/** In-memory fs over a path→content map. */
function memFs(files: Record<string, string>): IndexFs {
  return {
    async readFile(path) {
      return path in files ? files[path] : null;
    },
    async readDir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return Object.keys(files)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length));
    },
  };
}

const ROOT = "/repo";
const adr = (id: string, body: string, supersedes = "") =>
  `---\nadr-id: ${id}\nstatus: accepted\nsupersedes:${supersedes}\n---\n\n# ${id}\n\n${body}`;

describe("buildIndex", () => {
  it("assembles decisions + principles and inverts the reference graph", async () => {
    const fs = memFs({
      [join(ROOT, "docs/adr/0001-a.md")]: adr("ADR-0001", "first"),
      [join(ROOT, "docs/adr/0002-b.md")]: adr("ADR-0002", "supersedes the first", " [ADR-0001]"),
      [join(ROOT, "docs/adr/0003-c.md")]: adr("ADR-0003", "see ADR-0001 for context"),
      [join(ROOT, "docs/adr/ADR-0000-template.md")]: adr("ADR-0000", "TEMPLATE — must be skipped"),
      [join(ROOT, "docs/adr/README.md")]: "# index, skipped",
      [join(ROOT, "docs/decisions.md")]: "- **A thing(2026-06-01)**: did it.",
      [join(ROOT, "docs/areas/decision-rails.md")]: "## 1. people only\n\nbody",
    });

    const index = await buildIndex(ROOT, fs);

    const ids = index.decisions.map((d) => d.id);
    expect(ids).toContain("ADR-0001");
    expect(ids).toContain("ADR-0002");
    expect(ids).toContain("DL-001");
    expect(ids).not.toContain("ADR-0000"); // template skipped
    expect(index.principles.map((p) => p.id)).toEqual(["INVARIANT-1"]);

    const a1 = index.getDecision("ADR-0001")!;
    expect(a1.supersededBy).toEqual(["ADR-0002"]); // inverse of ADR-0002.supersedes
    expect(a1.referencedBy).toEqual(["ADR-0003"]); // inverse of ADR-0003.refs
    expect(index.getDecision("ADR-9999")).toBeNull();
  });

  it("degrades gracefully when sources are missing", async () => {
    const index = await buildIndex(ROOT, memFs({}));
    expect(index.decisions).toEqual([]);
    expect(index.principles).toEqual([]);
  });

  it("ingests governance-owned ADRs and the GDL-prefixed governance decision log", async () => {
    const fs = memFs({
      [join(ROOT, "docs/adr/0001-a.md")]: adr("ADR-0001", "app adr"),
      [join(ROOT, "governance/docs/adr/0007-g.md")]: adr("ADR-0007", "governance adr"),
      [join(ROOT, "docs/decisions.md")]: "- **App thing(2026-06-01)**: did it.",
      [join(ROOT, "governance/docs/decisions.md")]: "- **Gov thing(2026-06-07)**: did it.",
    });
    const index = await buildIndex(ROOT, fs);
    const ids = index.decisions.map((d) => d.id);
    expect(ids).toContain("ADR-0001"); // repo-root ADR dir (back-compat)
    expect(ids).toContain("ADR-0007"); // governance ADR dir (additive)
    expect(ids).toContain("DL-001"); // repo-root decision log
    expect(ids).toContain("GDL-001"); // governance decision log — distinct prefix, no collision
    expect(index.getDecision("ADR-0007")!.row.sourcePath).toBe("governance/docs/adr/0007-g.md");
    expect(index.getDecision("GDL-001")!.row.sourcePath).toBe("governance/docs/decisions.md");
  });

  it("throws on a duplicate ADR id across ADR dirs (no silent overwrite)", async () => {
    const fs = memFs({
      [join(ROOT, "docs/adr/0007-x.md")]: adr("ADR-0007", "in app dir"),
      [join(ROOT, "governance/docs/adr/0007-y.md")]: adr("ADR-0007", "duplicate in gov dir"),
    });
    await expect(buildIndex(ROOT, fs)).rejects.toThrow(/Duplicate ADR id ADR-0007/);
  });
});
