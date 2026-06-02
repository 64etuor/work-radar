import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCuratedKeys, listPatterns, getPattern } from "../../src/patterns/read.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-patread-"));
  for (const sub of ["candidates", "active", "archived"]) {
    await mkdir(join(ws, "patterns", sub), { recursive: true });
  }
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

async function seed(sub: string, id: string, fm: Record<string, unknown>, body = "x") {
  const front = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await writeFile(join(ws, "patterns", sub, `${id}.md`), `---\n${front}\n---\n${body}\n`, "utf8");
}

describe("loadCuratedKeys", () => {
  it("returns normalized (kind:scope) keys from active and archived, tolerating junk", async () => {
    await seed("active", "p1", { kind: "commit_scope_hotspot", scope: "Governance" });
    await seed("archived", "p2", { kind: "commit_scope_hotspot", scope: "news" });
    await writeFile(join(ws, "patterns", "active", ".gitkeep"), "", "utf8");
    await writeFile(join(ws, "patterns", "active", "broken.md"), "not valid frontmatter", "utf8");
    const keys = await loadCuratedKeys(ws);
    expect(keys.has("commit_scope_hotspot:governance")).toBe(true); // lowercased
    expect(keys.has("commit_scope_hotspot:news")).toBe(true);
    expect(keys.size).toBe(2);
  });

  it("returns an empty set when no curated dirs exist", async () => {
    const bare = await mkdtemp(join(tmpdir(), "boule-bare-"));
    expect((await loadCuratedKeys(bare)).size).toBe(0);
    await rm(bare, { recursive: true, force: true });
  });
});

describe("listPatterns / getPattern", () => {
  it("lists candidates with their frontmatter fields", async () => {
    await seed("candidates", "pat_scope_aaaa1111", {
      kind: "commit_scope_hotspot",
      scope: "governance",
      evidence_count: 7,
      confidence: 0.7,
      status: "candidate",
    });
    const list = await listPatterns(ws);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "pat_scope_aaaa1111",
      scope: "governance",
      evidence_count: 7,
      status: "candidate",
    });
  });

  it("getPattern finds a pattern by id across candidates/active/archived, else null", async () => {
    await seed(
      "candidates",
      "pat_scope_aaaa1111",
      { kind: "commit_scope_hotspot", scope: "governance" },
      "BODY-TEXT",
    );
    const got = await getPattern(ws, "pat_scope_aaaa1111");
    expect(got?.frontmatter.scope).toBe("governance");
    expect(got?.body).toContain("BODY-TEXT");
    expect(await getPattern(ws, "pat_scope_missing0")).toBeNull();
  });

  it("rejects a path-traversal id instead of reading files outside patterns/", async () => {
    // Plant a frontmatter .md OUTSIDE patterns/ (directly under the workspace root).
    await writeFile(join(ws, "secret.md"), "---\nkind: secret\nscope: LEAK\n---\nout-of-tree\n", "utf8");
    // ws/patterns/candidates + ../../secret.md → ws/secret.md if traversal is allowed.
    expect(await getPattern(ws, "../../secret")).toBeNull();
    expect(await getPattern(ws, "../../../../../../../../etc/passwd")).toBeNull();
  });
});
