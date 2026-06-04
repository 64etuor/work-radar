import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/graph/store.js";
import { rebuildIndex, upsertIndex } from "../../src/graph/ingest.js";

async function seedWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "boule-f-inc-"));
  await mkdir(join(ws, "events", "2026-06-03"), { recursive: true });
  return ws;
}

async function seedEvent(ws: string, id: string, type: string, related?: string[]) {
  const day = id.slice(4, 12).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  const dir = join(ws, "events", day);
  await mkdir(dir, { recursive: true });
  const rel = related?.length ? `related_to:\n${related.map((r) => `  - ${r}`).join("\n")}\n` : "";
  await writeFile(
    join(dir, `${id}.md`),
    `---\nid: ${id}\ntype: ${type}\nsource: hermes\nactor: u\ntags: []\n${rel}---\nTitle for ${id}\n`,
    "utf8",
  );
}

describe("incremental graph upsert", () => {
  it("matches a full rebuild checksum after appending new events", async () => {
    const ws = await seedWorkspace();
    await seedEvent(ws, "evt_20260603_101500_0001", "task_created");

    const incremental = await openStore(":memory:");
    const rebuilt = await openStore(":memory:");
    await upsertIndex(ws, incremental);

    await seedEvent(ws, "evt_20260603_101600_0002", "task_started", ["evt_20260603_101500_0001"]);
    const incrementalStatus = await upsertIndex(ws, incremental);
    const rebuildStatus = await rebuildIndex(ws, rebuilt);

    expect(incrementalStatus).toEqual(rebuildStatus);

    await incremental.close();
    await rebuilt.close();
  });

  it("removes rows that disappear from the markdown corpus", async () => {
    const ws = await seedWorkspace();
    const taskId = "evt_20260603_101500_0001";
    const startedId = "evt_20260603_101600_0002";
    await seedEvent(ws, taskId, "task_created");
    await seedEvent(ws, startedId, "task_started", [taskId]);

    const incremental = await openStore(":memory:");
    const rebuilt = await openStore(":memory:");
    await upsertIndex(ws, incremental);
    await rm(join(ws, "events", "2026-06-03", `${startedId}.md`));

    const incrementalStatus = await upsertIndex(ws, incremental);
    const rebuildStatus = await rebuildIndex(ws, rebuilt);

    expect(incrementalStatus).toEqual(rebuildStatus);
    expect((await incremental.getNode(`task:${taskId}`))?.state_jsonb.phase).toBe("ready");

    await incremental.close();
    await rebuilt.close();
  });
});
