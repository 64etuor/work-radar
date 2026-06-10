import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { curatePattern } from "../../src/patterns/curate.js";
import { loadCuratedKeys } from "../../src/patterns/read.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-curate-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const PATTERN = (id: string, status: string) =>
  `---\nid: ${id}\nkind: commit_scope_hotspot\nscope: news\nevidence_count: 4\nconfidence: 0.5\nstatus: ${status}\n---\nbody\n`;

async function seed(sub: string, id: string, status: string) {
  await mkdir(join(ws, "patterns", sub), { recursive: true });
  await writeFile(join(ws, "patterns", sub, `${id}.md`), PATTERN(id, status));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("curatePattern activate", () => {
  it("moves candidate → active, rewrites status, records actor", async () => {
    await seed("candidates", "pat_a", "candidate");

    const r = await curatePattern(ws, "pat_a", "activate", "user");

    expect(r).toEqual({ outcome: "moved", from: "candidates", to: "active" });
    expect(await exists(join(ws, "patterns", "candidates", "pat_a.md"))).toBe(false);
    const { data } = matter(await readFile(join(ws, "patterns", "active", "pat_a.md"), "utf8"));
    expect(data.status).toBe("active");
    expect(data.curated_by).toBe("user");
    expect(data.scope).toBe("news"); // rest of frontmatter preserved
  });

  it("is idempotent: already active → already, file untouched", async () => {
    await seed("active", "pat_a", "active");

    const r = await curatePattern(ws, "pat_a", "activate", "user");

    expect(r).toEqual({ outcome: "already", to: "active" });
  });

  it("does NOT activate an archived pattern (un-archiving is manual git)", async () => {
    await seed("archived", "pat_a", "archived");

    const r = await curatePattern(ws, "pat_a", "activate", "user");

    expect(r.outcome).toBe("not_found");
    expect(await exists(join(ws, "patterns", "archived", "pat_a.md"))).toBe(true);
  });

  it("activated pattern joins the curated set (won't be re-detected)", async () => {
    await seed("candidates", "pat_a", "candidate");
    await curatePattern(ws, "pat_a", "activate", "user");

    const keys = await loadCuratedKeys(ws);
    expect(keys.has("commit_scope_hotspot:news")).toBe(true);
  });
});

describe("curatePattern archive", () => {
  it("moves candidate → archived", async () => {
    await seed("candidates", "pat_a", "candidate");

    const r = await curatePattern(ws, "pat_a", "archive", "user");

    expect(r).toEqual({ outcome: "moved", from: "candidates", to: "archived" });
    const { data } = matter(await readFile(join(ws, "patterns", "archived", "pat_a.md"), "utf8"));
    expect(data.status).toBe("archived");
  });

  it("demotes active → archived", async () => {
    await seed("active", "pat_a", "active");

    const r = await curatePattern(ws, "pat_a", "archive", "user");

    expect(r).toEqual({ outcome: "moved", from: "active", to: "archived" });
  });
});

describe("curatePattern guards", () => {
  it("rejects path-traversal ids before touching the filesystem", async () => {
    expect((await curatePattern(ws, "../evil", "activate", "user")).outcome).toBe("unsafe_id");
    expect((await curatePattern(ws, "a/b", "archive", "user")).outcome).toBe("unsafe_id");
  });

  it("unknown id → not_found", async () => {
    expect((await curatePattern(ws, "pat_missing", "activate", "user")).outcome).toBe("not_found");
  });
});
