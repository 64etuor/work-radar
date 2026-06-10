import { describe, it, expect } from "vitest";
import { openStore } from "../../src/graph/store.js";
import { projectGraph } from "../../src/graph/project.js";
import { checksumProjection } from "../../src/graph/checksum.js";
import type { GovEvent } from "../../src/event/event.js";

function evt(over: Partial<GovEvent["frontmatter"]>, body = "Title"): GovEvent {
  return {
    frontmatter: { id: "x", type: "task_created", source: "hermes", actor: "u", tags: [], ...over },
    body,
  };
}

const events: GovEvent[] = [
  evt({ id: "t1", type: "task_created" }, "Task one"),
  evt({ id: "ts1", type: "task_started", related_to: ["t1"] }),
  evt({ id: "p1", type: "plan_proposed" }, "Plan one"),
];

// PGlite-heavy: can exceed the 5s default under full-suite worker load.
describe("graph store (PGlite :memory:)", { timeout: 20_000 }, () => {
  it("rebuilds, reports status, and round-trips checksum equal to the projection", async () => {
    const store = await openStore(":memory:");
    const proj = projectGraph(events);
    await store.rebuild(proj);
    const st = await store.status();
    expect(st.nodes).toBe(proj.nodes.length);
    expect(st.events).toBe(proj.events.length);
    expect(st.checksum).toBe(checksumProjection(proj));
    await store.close();
  });

  it("is idempotent — rebuild twice yields the identical checksum", async () => {
    const store = await openStore(":memory:");
    await store.rebuild(projectGraph(events));
    const first = (await store.status()).checksum;
    await store.rebuild(projectGraph(events)); // TRUNCATE + reinsert
    expect((await store.status()).checksum).toBe(first);
    await store.close();
  });

  it("serves getNode and getNeighbors", async () => {
    const store = await openStore(":memory:");
    await store.rebuild(projectGraph(events));
    const t1 = await store.getNode("task:t1");
    expect(t1?.title).toBe("Task one");
    expect(t1?.state_jsonb.phase).toBe("active"); // state_jsonb survives the DB round-trip field-for-field
    expect(await store.getNode("task:missing")).toBeNull();
    const nb = await store.getNeighbors("task:t1");
    expect(nb?.node.node_id).toBe("task:t1");
    await store.close();
  });

  it("the :memory: sentinel creates no on-disk dir (truly ephemeral)", async () => {
    const { existsSync } = await import("node:fs");
    const store = await openStore(":memory:");
    await store.rebuild(projectGraph(events));
    expect(existsSync(":memory:")).toBe(false); // sentinel must NOT be forwarded to PGlite as a path
    await store.close();
  });

  it("file-backed open creates missing parent dirs (PGlite mkdirs only the leaf)", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "boule-f-store-"));
    const loc = join(base, "index", "pglite"); // parent "index" does NOT exist yet
    const store = await openStore(loc);
    await store.rebuild(projectGraph(events));
    expect((await store.status()).nodes).toBe(projectGraph(events).nodes.length);
    await store.close();
  });
});
