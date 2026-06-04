import { readAllEvents } from "../decision/readEvents.ts";
import { projectGraph } from "./project.ts";
import type { GraphStore, IndexStatus } from "./types.ts";

/** On-demand rebuild: load markdown events → pure projection → store.rebuild. Read-only over L0
 *  (reads events; writes ZERO events). Returns post-rebuild status. */
export async function rebuildIndex(workspaceDir: string, store: GraphStore): Promise<IndexStatus> {
  const events = await readAllEvents(workspaceDir);
  await store.rebuild(projectGraph(events));
  return store.status();
}

/** Incremental sync: load markdown events → pure projection → store.upsert. This keeps the
 *  PGlite cache equivalent to rebuild without TRUNCATE, and still writes ZERO L0 events. */
export async function upsertIndex(workspaceDir: string, store: GraphStore): Promise<IndexStatus> {
  const events = await readAllEvents(workspaceDir);
  await store.upsert(projectGraph(events));
  return store.status();
}
