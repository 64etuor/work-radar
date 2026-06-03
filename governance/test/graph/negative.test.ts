import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/graph/store.js";
import { rebuildIndex } from "../../src/graph/ingest.js";

/** Snapshot every event file's path → content, so we can prove ingest neither adds nor MODIFIES L0. */
async function snapshotEvents(day: string): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  for (const f of await readdir(day)) snap.set(f, await readFile(join(day, f), "utf8"));
  return snap;
}

describe("graph ingest is read-only over L0 (INVARIANT #1)", () => {
  it("adds no new event files AND modifies no existing event content", async () => {
    const ws = await mkdtemp(join(tmpdir(), "boule-f-neg-"));
    const day = join(ws, "events", "2026-06-03");
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, "evt_20260603_101500_0001.md"),
      `---\nid: evt_20260603_101500_0001\ntype: task_created\nsource: hermes\nactor: u\ntags: []\n---\nTask\n`,
    );
    const before = await snapshotEvents(day);

    const store = await openStore(":memory:");
    await rebuildIndex(ws, store);
    await rebuildIndex(ws, store);
    await store.close();

    const after = await snapshotEvents(day);
    // Byte-for-byte identical map → graph layer minted nothing and overwrote nothing.
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });
});
