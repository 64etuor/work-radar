import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistMetaProposal, proposalId } from "../../src/meta/persist.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-meta-persist-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("persistMetaProposal", () => {
  it("writes the draft under meta/proposals/ with a content-addressed id", async () => {
    const md = "# Principle proposal\n\n- scope news persists\n";

    const r = await persistMetaProposal(ws, md);

    expect(r.outcome).toBe("written");
    expect(r.id).toBe(proposalId(md));
    expect(r.id).toMatch(/^mep_[0-9a-f]{8}$/);
    expect(await readFile(r.path, "utf8")).toBe(md);
  });

  it("is idempotent: same draft → skipped, one file", async () => {
    const md = "# Principle proposal\n";
    await persistMetaProposal(ws, md);

    const r = await persistMetaProposal(ws, md);

    expect(r.outcome).toBe("skipped");
    expect(await readdir(join(ws, "meta", "proposals"))).toHaveLength(1);
  });

  it("different drafts get distinct files (no overwrite of prior proposals)", async () => {
    await persistMetaProposal(ws, "draft A\n");
    await persistMetaProposal(ws, "draft B\n");

    expect((await readdir(join(ws, "meta", "proposals"))).sort()).toHaveLength(2);
  });
});
