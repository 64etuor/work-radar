import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/graph/store.js";
import { rebuildIndex } from "../../src/graph/ingest.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { projectGraph } from "../../src/graph/project.js";
import { checksumProjection } from "../../src/graph/checksum.js";
import type { GovEvent } from "../../src/event/event.js";

const PGLITE_TEST_TIMEOUT_MS = 15000;

async function seedWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "boule-f-"));
  const day = join(ws, "events", "2026-06-03");
  await mkdir(day, { recursive: true });
  const md = (id: string, type: string, rel?: string) =>
    `---\nid: ${id}\ntype: ${type}\nsource: hermes\nactor: u\ntags: []\n${rel ? `related_to:\n  - ${rel}\n` : ""}---\nTitle for ${id}\n`;
  await writeFile(join(day, "evt_20260603_101500_0001.md"), md("evt_20260603_101500_0001", "task_created"));
  await writeFile(join(day, "evt_20260603_101600_0002.md"), md("evt_20260603_101600_0002", "task_started", "evt_20260603_101500_0001"));
  return ws;
}

describe("rebuild equivalence (DB == markdown-derived projection)", () => {
  it("status checksum equals the pure projection checksum", async () => {
    const ws = await seedWorkspace();
    const store = await openStore(":memory:");
    const st = await rebuildIndex(ws, store);
    const expected = checksumProjection(projectGraph(await readAllEvents(ws)));
    expect(st.checksum).toBe(expected);
    await store.close();
  }, PGLITE_TEST_TIMEOUT_MS);

  it("is idempotent across a second rebuild", async () => {
    const ws = await seedWorkspace();
    const store = await openStore(":memory:");
    const a = await rebuildIndex(ws, store);
    const b = await rebuildIndex(ws, store);
    expect(b.checksum).toBe(a.checksum);
    await store.close();
  }, PGLITE_TEST_TIMEOUT_MS);

  // The real workspace may have ~0 events; this synthetic fixture exercises EVERY node + edge
  // type through projection AND DB persistence so the keystone is not proven on tasks alone.
  it("covers every node and edge type end-to-end (multi-axis fixture)", async () => {
    const f = (id: string, type: string, related?: string[], supersededBy?: string): GovEvent => ({
      frontmatter: {
        id, type: type as GovEvent["frontmatter"]["type"], source: "hermes", actor: "u", tags: [],
        ...(related ? { related_to: related } : {}), ...(supersededBy ? { supersededBy } : {}),
      },
      body: `Title ${id}`,
    });
    const events: GovEvent[] = [
      f("dec1", "decision_proposed"),
      f("db1", "decision_blocked", ["dec1", "t1"]),   // blocks: decision:dec1 → task:t1
      f("t1", "task_created"),
      f("p1", "plan_proposed"),
      f("p2", "plan_proposed"),
      f("sup1", "plan_superseded", ["p1"], "p2"),       // supersedes: plan:p1 → plan:p2
      f("sb1", "step_bound", ["p1", "t1"]),             // step_of: task:t1 → plan:p1
      f("sp1", "spec_proposed"),
      f("ses1", "session_spawned", ["t1", "ghost_x"]),  // related_to: session→task:t1 ; refs: session→ghost_x
    ];
    const proj = projectGraph(events);
    expect(new Set(proj.nodes.map((n) => n.node_type))).toEqual(
      new Set(["decision", "task", "plan", "spec", "session"]),
    );
    expect(new Set(proj.edges.map((e) => e.edge_type))).toEqual(
      new Set(["blocks", "supersedes", "step_of", "related_to", "refs"]),
    );

    const store = await openStore(":memory:");
    await store.rebuild(proj);
    const first = (await store.status()).checksum;
    await store.rebuild(projectGraph(events)); // idempotent + DB == pure projection
    expect((await store.status()).checksum).toBe(first);
    expect((await store.status()).checksum).toBe(checksumProjection(proj));
    await store.close();
  }, PGLITE_TEST_TIMEOUT_MS);
});
