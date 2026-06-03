import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/graph/store.js";
import { rebuildIndex } from "../../src/graph/ingest.js";

describe("graph ingest is read-only over L0 (INVARIANT #1)", () => {
  it("writes zero new event files when rebuilding the index", async () => {
    const ws = await mkdtemp(join(tmpdir(), "boule-f-neg-"));
    const day = join(ws, "events", "2026-06-03");
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, "evt_20260603_101500_0001.md"),
      `---\nid: evt_20260603_101500_0001\ntype: task_created\nsource: hermes\nactor: u\ntags: []\n---\nTask\n`,
    );
    const before = (await readdir(day)).length;

    const store = await openStore(":memory:");
    await rebuildIndex(ws, store);
    await rebuildIndex(ws, store);
    await store.close();

    expect((await readdir(day)).length).toBe(before); // no events minted by the graph layer
  });
});
